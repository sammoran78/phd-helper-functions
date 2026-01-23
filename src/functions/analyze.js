const { app } = require('@azure/functions');
const { downloadBlob } = require('../../shared/blobClient');
const { extractTextFromBuffer } = require('../../shared/textExtractor');
const OpenAI = require('openai');

// POST /api/references/analyze - Analyze a document with OpenAI
app.http('AnalyzeReference', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'references/analyze',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const { blobName, fileName, section } = body;
            
            if (!blobName || !section) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'blobName and section are required' })
                };
            }
            
            // Download file from blob storage
            const containerName = process.env.BLOB_CONTAINER_UPLOADS || 'uploads';
            const buffer = await downloadBlob(containerName, blobName);
            
            // Determine file type
            const name = fileName || blobName;
            const extension = name.split('.').pop().toLowerCase();
            let fileType = 'unknown';
            if (extension === 'pdf') fileType = 'pdf';
            else if (extension === 'docx') fileType = 'docx';
            
            // Extract text from document
            const text = await extractTextFromBuffer(buffer, fileType);
            
            if (!text || text.length < 100) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Could not extract sufficient text from document' })
                };
            }
            
            // Prepare prompt based on section
            const prompts = {
                summary: `Please provide a concise academic summary (2-3 paragraphs) of the following research paper. Focus on the main research question, methodology, key findings, and conclusions:\n\n${text.substring(0, 15000)}`,
                theory: `Please identify and explain the theoretical framework(s) used in this research paper. Include the main theories referenced, how they are applied, and their relevance to the research:\n\n${text.substring(0, 15000)}`,
                method: `Please describe the research methodology used in this paper. Include the research design, data collection methods, sample/participants, and analysis techniques:\n\n${text.substring(0, 15000)}`
            };
            
            const prompt = prompts[section];
            if (!prompt) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Invalid section. Use: summary, theory, or method' })
                };
            }
            
            // Call OpenAI
            const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
            const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
            
            const completion = await openai.chat.completions.create({
                model: model,
                messages: [
                    { role: 'system', content: 'You are an academic research assistant helping to analyze scholarly papers.' },
                    { role: 'user', content: prompt }
                ],
                max_tokens: 1500,
                temperature: 0.3
            });
            
            const result = completion.choices[0]?.message?.content || '';
            
            context.log(`Analyzed document for section: ${section}`);
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    success: true,
                    section: section,
                    content: result
                })
            };
        } catch (error) {
            context.error('Analyze Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to analyze document', details: error.message })
            };
        }
    }
});
