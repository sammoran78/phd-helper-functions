const { app } = require('@azure/functions');
const { downloadBlob } = require('../shared/blobClient');
const { extractTextFromBuffer } = require('../shared/textExtractor');
const OpenAI = require('openai');

app.http('AnalyzeReference', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'references/analyze',
    handler: async (request, context) => {
        try {
            if (!process.env.OPENAI_API_KEY) {
                return {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'OPENAI_API_KEY not configured' })
                };
            }

            const body = await request.json();
            const { fileUrl, fileName, section, blobName } = body;
            
            const requestStart = Date.now();
            context.log('[RefAnalyze] Request start', { section, fileName, blobName });
            
            if (!fileUrl && !blobName) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'No file URL or blob name provided' })
                };
            }

            const containerName = process.env.BLOB_CONTAINER_UPLOADS || 'uploads';
            
            // Extract blob name from URL if not provided
            let actualBlobName = blobName;
            if (!actualBlobName && fileUrl) {
                const urlParts = fileUrl.split('/');
                actualBlobName = urlParts[urlParts.length - 1];
            }
            
            context.log('[RefAnalyze] Downloading blob', { actualBlobName });
            const extractStart = Date.now();
            
            // Download from Blob Storage
            const buffer = await downloadBlob(containerName, actualBlobName);
            
            // Extract text
            const fileExt = fileName.split('.').pop().toLowerCase();
            const text = await extractTextFromBuffer(buffer, fileExt);
            
            context.log('[RefAnalyze] Text extracted', {
                elapsedMs: Date.now() - extractStart,
                extractedChars: text.length
            });
            
            // Truncate text if too long (approx 15k tokens to be safe)
            const truncatedText = text.slice(0, 60000);
            
            const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
            const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
            const reasoningEffort = process.env.OPENAI_REASONING_EFFORT || 'low';

            let systemPrompt = '';
            let userPrompt = '';

            if (section === 'summary') {
                systemPrompt = "You are a research assistant. Analyze the academic paper and extract a summary.";
                userPrompt = `Analyze this text and provide:
                1. A 1-3 sentence 'elevator pitch' summary of the central claim/problem.
                2. A comma-separated list of the author's key keywords/concepts.
                
                Return JSON format: { "summary": "...", "keywords": "..." }
                
                Text: ${truncatedText}`;
            } else if (section === 'theory') {
                systemPrompt = "You are a research assistant. Analyze the academic paper for theoretical frameworks.";
                userPrompt = `Analyze this text and extract:
                1. The specific theoretical frameworks used (e.g., Actor-Network Theory).
                2. Key concepts defined by the authors (brief definitions).
                3. Potential connection to themes of: Intentionality, Agency, Sustainability in Creative AI (brief notes).
                
                Return JSON format: { "frameworks": "...", "concepts": "...", "connection": "..." }
                
                Text: ${truncatedText}`;
            } else if (section === 'method') {
                systemPrompt = "You are a research assistant. Analyze the academic paper for methodology.";
                userPrompt = `Analyze this text and extract:
                1. Research Design (e.g., Ethnography, Case Study).
                2. Sample/Data details (e.g., N=24 illustrators).
                3. Methods & Analysis approach.
                4. Limitations mentioned.
                
                Return JSON format: { "design": "...", "sample": "...", "analysis": "...", "limitations": "..." }
                
                Text: ${truncatedText}`;
            } else {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Invalid section type' })
                };
            }

            context.log(`Sending to OpenAI (${section})...`);
            const openaiStart = Date.now();
            
            const basePayload = {
                model: model,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt }
                ],
                response_format: { type: "json_object" }
            };

            let completion;
            let usedReasoningEffort = false;
            try {
                completion = await openai.chat.completions.create({
                    ...basePayload,
                    reasoning_effort: reasoningEffort,
                });
                usedReasoningEffort = true;
            } catch (err) {
                const msg = (err && err.message) ? err.message : String(err);
                context.warn('OpenAI request with reasoning_effort failed; retrying without it. Error:', msg);
                completion = await openai.chat.completions.create(basePayload);
            }

            context.log('[RefAnalyze] OpenAI completed', {
                elapsedMs: Date.now() - openaiStart,
                usedReasoningEffort,
                model
            });

            const result = JSON.parse(completion.choices[0].message.content);
            context.log('[RefAnalyze] Parsed JSON result', {
                keys: Object.keys(result),
                totalElapsedMs: Date.now() - requestStart
            });

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(result)
            };

        } catch (error) {
            context.error('Analysis error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Analysis failed: ' + error.message })
            };
        }
    }
});
