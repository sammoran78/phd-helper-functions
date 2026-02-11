const { app } = require('@azure/functions');
const { getItem, upsertItem, queryItems } = require('../../shared/cosmosClient');

const CONTAINER_NAME = process.env.COSMOSDB_CONTAINER_CHATS || 'chats';
const SYSTEM_PROMPT_DOC_ID = process.env.COSMOSDB_SYSTEM_PROMPT_ID || 'kb_system_prompt';

// GET /api/kb/system-prompt - Fetch global system prompt
app.http('GetSystemPrompt', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'kb/system-prompt',
    handler: async (request, context) => {
        try {
            let doc = await getItem(CONTAINER_NAME, SYSTEM_PROMPT_DOC_ID, SYSTEM_PROMPT_DOC_ID);
            if (!doc) {
                const matches = await queryItems(CONTAINER_NAME, {
                    query: 'SELECT TOP 1 * FROM c WHERE c.id = @id',
                    parameters: [{ name: '@id', value: SYSTEM_PROMPT_DOC_ID }]
                });
                doc = Array.isArray(matches) ? matches[0] : null;
            }
            const content = doc?.content ?? doc?.systemPrompt ?? doc?.prompt ?? '';

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: SYSTEM_PROMPT_DOC_ID,
                    content: (content || '').toString()
                })
            };
        } catch (error) {
            context.error('Get System Prompt Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    error: 'Failed to load system prompt',
                    details: error.message
                })
            };
        }
    }
});

// PUT /api/kb/system-prompt - Update global system prompt
app.http('UpdateSystemPrompt', {
    methods: ['PUT'],
    authLevel: 'anonymous',
    route: 'kb/system-prompt',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const content = (body?.content ?? body?.systemPrompt ?? body?.prompt ?? '').toString();

            const existing = await getItem(CONTAINER_NAME, SYSTEM_PROMPT_DOC_ID, SYSTEM_PROMPT_DOC_ID);
            const now = new Date().toISOString();

            const updatedDoc = {
                ...(existing || {}),
                id: SYSTEM_PROMPT_DOC_ID,
                type: existing?.type || 'system_prompt',
                content,
                createdAt: existing?.createdAt || now,
                updatedAt: now
            };

            const saved = await upsertItem(CONTAINER_NAME, updatedDoc);

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(saved)
            };
        } catch (error) {
            context.error('Update System Prompt Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    error: 'Failed to update system prompt',
                    details: error.message
                })
            };
        }
    }
});
