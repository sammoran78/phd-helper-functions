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
            
            context.log(`[Analyze] Request received: section=${section}, blobName=${blobName}, fileName=${fileName}`);
            
            if (!blobName || !section) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'blobName and section are required' })
                };
            }
            
            // Check for required env vars
            if (!process.env.BLOB_STORAGE_CONNECTION_STRING) {
                context.error('[Analyze] BLOB_STORAGE_CONNECTION_STRING not set');
                return {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Blob storage not configured' })
                };
            }
            
            if (!process.env.OPENAI_API_KEY) {
                context.error('[Analyze] OPENAI_API_KEY not set');
                return {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'OpenAI API key not configured' })
                };
            }
            
            // Download file from blob storage
            const containerName = process.env.BLOB_CONTAINER_UPLOADS || 'uploads';
            context.log(`[Analyze] Downloading from container: ${containerName}, blob: ${blobName}`);
            
            let buffer;
            try {
                buffer = await downloadBlob(containerName, blobName);
                context.log(`[Analyze] Downloaded ${buffer.length} bytes`);
            } catch (downloadError) {
                context.error('[Analyze] Download failed:', downloadError.message);
                return {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Failed to download file from storage', details: downloadError.message })
                };
            }
            
            // Determine file type
            const name = fileName || blobName;
            const extension = name.split('.').pop().toLowerCase();
            let fileType = 'unknown';
            if (extension === 'pdf') fileType = 'pdf';
            else if (extension === 'docx') fileType = 'docx';
            
            context.log(`[Analyze] File type detected: ${fileType}`);
            
            // Extract text from document
            let text;
            try {
                text = await extractTextFromBuffer(buffer, fileType);
                context.log(`[Analyze] Extracted ${text?.length || 0} characters`);
            } catch (extractError) {
                context.error('[Analyze] Text extraction failed:', extractError.message);
                return {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Failed to extract text from document', details: extractError.message })
                };
            }
            
            if (!text || text.length < 100) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Could not extract sufficient text from document' })
                };
            }
            
            // Prepare prompt based on section
            const prompts = {
                summary: `Return a JSON object with keys: "summary" and "keywords".
"summary" should be a concise academic summary (2-3 paragraphs) focusing on research question, methodology, key findings, and conclusions.
"keywords" should be a comma-separated list of key terms.
Respond with JSON only.

Paper text:
${text.substring(0, 15000)}`,
                theory: `Return a JSON object with keys: "frameworks", "concepts", "connection".
"frameworks": theoretical frameworks used.
"concepts": key concepts/definitions.
"connection": how this connects to the user's framework.
Respond with JSON only.

Paper text:
${text.substring(0, 15000)}`,
                method: `Return a JSON object with keys: "design", "sample", "analysis", "limitations".
"design": research design.
"sample": participants/sample.
"analysis": analysis techniques.
"limitations": methodological limitations.
Respond with JSON only.

Paper text:
${text.substring(0, 15000)}`
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
            context.log('[Analyze] Calling OpenAI...');
            const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
            const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
            
            const completion = await openai.chat.completions.create({
                model: model,
                messages: [
                    { role: 'system', content: 'You are an academic research assistant helping to analyze scholarly papers.' },
                    { role: 'user', content: prompt }
                ],
                response_format: { type: 'json_object' },
                max_completion_tokens: 1500,
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
