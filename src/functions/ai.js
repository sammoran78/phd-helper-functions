const { app } = require('@azure/functions');
const OpenAI = require('openai');

// POST /api/ai/chat - Generic OpenAI chat completion
app.http('AIChat', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'ai/chat',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const { messages, max_tokens = 500, temperature = 0.7 } = body;
            
            if (!messages || !Array.isArray(messages) || messages.length === 0) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'messages array is required' })
                };
            }
            
            if (!process.env.OPENAI_API_KEY) {
                context.error('[AI Chat] OPENAI_API_KEY not set');
                return {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'OpenAI API key not configured' })
                };
            }
            
            const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
            const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
            
            context.log(`[AI Chat] Calling OpenAI with ${messages.length} messages`);
            
            const completion = await openai.chat.completions.create({
                model: model,
                messages: messages,
                max_completion_tokens: max_tokens,
                temperature: temperature
            });
            
            const content = completion.choices[0]?.message?.content || '';
            
            context.log(`[AI Chat] Response received: ${content.length} chars`);
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content: content,
                    choices: completion.choices,
                    usage: completion.usage
                })
            };
        } catch (error) {
            context.error('[AI Chat] Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'AI request failed', details: error.message })
            };
        }
    }
});
