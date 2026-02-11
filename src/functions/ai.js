const { app } = require('@azure/functions');
const OpenAI = require('openai');
const { getItem, queryItems } = require('../../shared/cosmosClient');

const CONTAINER_PAGES = process.env.COSMOSDB_CONTAINER_PAGES || 'pages';
const CONTAINER_REFERENCES = process.env.COSMOSDB_CONTAINER_REFERENCES || 'references';
const CONTAINER_CHATS = process.env.COSMOSDB_CONTAINER_CHATS || 'chats';
const SYSTEM_PROMPT_DOC_ID = process.env.COSMOSDB_SYSTEM_PROMPT_ID || 'kb_system_prompt';

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

function getOutputText(response) {
    if (!response) return '';
    if (typeof response.output_text === 'string') return response.output_text;

    const output = Array.isArray(response.output) ? response.output : [];
    const messageItems = output.filter(item => item && item.type === 'message');
    const texts = [];
    for (const msg of messageItems) {
        const content = Array.isArray(msg.content) ? msg.content : [];
        for (const c of content) {
            if (c && typeof c.text === 'string') {
                texts.push(c.text);
            } else if (c && c.type === 'output_text' && typeof c.text === 'string') {
                texts.push(c.text);
            }
        }
    }
    return texts.join('\n').trim();
}

function extractCitationIds(text) {
    const ids = [];
    if (!text || typeof text !== 'string') return ids;
    const re = /\{\{cite:([^}]+)\}\}/g;
    let match;
    while ((match = re.exec(text)) !== null) {
        const id = (match[1] || '').trim();
        if (id && !ids.includes(id)) ids.push(id);
    }
    return ids;
}

function buildApa7Fallback(reference) {
    const authors = reference?.authors || reference?.author || 'Unknown Author';
    const year = reference?.year || 'n.d.';
    const title = reference?.title || 'Untitled';
    const source = reference?.source || '';
    let citation = `${authors} (${year}). ${title}.`;
    if (source) citation += ` ${source}.`;
    return citation;
}

async function getSystemPrompt(context) {
    if (!SYSTEM_PROMPT_DOC_ID) return '';
    try {
        let doc = await getItem(CONTAINER_CHATS, SYSTEM_PROMPT_DOC_ID, SYSTEM_PROMPT_DOC_ID);
        if (!doc) {
            const matches = await queryItems(CONTAINER_CHATS, {
                query: 'SELECT TOP 1 * FROM c WHERE c.id = @id',
                parameters: [{ name: '@id', value: SYSTEM_PROMPT_DOC_ID }]
            });
            doc = Array.isArray(matches) ? matches[0] : null;
        }
        const raw = doc?.content ?? doc?.systemPrompt ?? doc?.prompt ?? '';
        return (raw || '').toString().replace(/\\n/g, '\n').replace(/\\r/g, '\r').trim();
    } catch (err) {
        if (context?.warn) {
            context.warn('[KB RAG] Failed to load system prompt', err?.message || String(err));
        }
        return '';
    }
}

async function lookupCitationByFileId(fileId) {
    if (!fileId) return null;

    const pages = await queryItems(CONTAINER_PAGES, {
        query: 'SELECT TOP 1 * FROM c WHERE IS_DEFINED(c.openaiVector) AND c.openaiVector.fileId = @fileId',
        parameters: [{ name: '@fileId', value: fileId }]
    });
    const page = Array.isArray(pages) && pages.length > 0 ? pages[0] : null;
    if (!page) {
        return {
            id: fileId,
            authors: 'Unknown Author',
            year: 'n.d.',
            title: 'Unknown Title',
            pageUrl: '',
            apa7: 'Source unavailable'
        };
    }

    const referenceId = page.referenceId;
    const reference = referenceId ? await getItem(CONTAINER_REFERENCES, referenceId, referenceId) : null;

    const authors = reference?.authors || reference?.author || page?.metadata?.authors || 'Unknown Author';
    const year = (reference?.year || page?.metadata?.year || 'n.d.').toString();
    const title = reference?.title || page?.metadata?.title || 'Untitled';
    const apa7 = (reference?.apa7 || '').toString().trim() || buildApa7Fallback(reference || page?.metadata);

    return {
        id: fileId,
        referenceId: referenceId || null,
        pageNumber: page.pageNumber != null ? String(page.pageNumber) : null,
        title,
        authors,
        year,
        pageUrl: page.blobUrl || '',
        blobUrl: page.blobUrl || '',
        apa7
    };
}

app.http('KBRagChat', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'kb/rag-chat',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const query = (body?.query || body?.message || '').toString().trim();
            const chatId = (body?.chatId || '').toString().trim();
            const useReasoning = Boolean(body?.reasoning);
            const reasoningEffort = (process.env.OPENAI_REASONING_EFFORT || '').toString().trim();
            const systemPrompt = await getSystemPrompt(context);

            if (!query) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'query is required' })
                };
            }

            if (!process.env.OPENAI_API_KEY) {
                return {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'OpenAI API key not configured' })
                };
            }

            const vectorStoreId = process.env.OPENAI_VECTOR_STORE;
            if (!vectorStoreId) {
                return {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'OPENAI_VECTOR_STORE environment variable not configured' })
                };
            }

            const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
            const model = (process.env.OPENAI_MODEL || '').toString().trim();
            if (!model) {
                return {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'OPENAI_MODEL environment variable not configured' })
                };
            }

            let historyText = '';
            if (chatId) {
                const chat = await getItem(CONTAINER_CHATS, chatId, chatId);
                if (chat && Array.isArray(chat.messages) && chat.messages.length > 0) {
                    const recent = chat.messages.slice(-12);
                    historyText = recent
                        .map(m => `${(m.role || 'user').toUpperCase()}: ${(m.content || '').toString()}`)
                        .join('\n');
                }
            }

            const input = [
                systemPrompt,
                'You are a research assistant. Answer using ONLY the provided file search results from the user\'s academic corpus.',
                'When you make a claim that is supported by a source, append a citation marker in the exact form {{cite:FILE_ID}} where FILE_ID is the OpenAI file id for that source.',
                'Keep answers concise but academically rigorous.',
                historyText ? `Conversation so far:\n${historyText}` : '',
                `User question: ${query}`
            ].filter(Boolean).join('\n\n');

            const basePayload = {
                model,
                input,
                tools: [
                    {
                        type: 'file_search',
                        vector_store_ids: [vectorStoreId]
                    }
                ]
            };

            let response;
            try {
                response = await openai.responses.create({
                    ...basePayload,
                    include: ['file_search_call.results'],
                    ...(useReasoning && reasoningEffort ? { reasoning_effort: reasoningEffort } : {})
                });
            } catch (err) {
                const msg = (err && err.message) ? err.message : String(err);
                if (useReasoning && reasoningEffort) {
                    context.warn('[KB RAG Chat] reasoning_effort rejected; retrying without it. Error:', msg);
                    try {
                        response = await openai.responses.create({
                            ...basePayload,
                            include: ['file_search_call.results']
                        });
                    } catch (retryErr) {
                        response = await openai.responses.create(basePayload);
                    }
                } else {
                    response = await openai.responses.create(basePayload);
                }
            }

            const content = getOutputText(response);
            const citationIds = extractCitationIds(content);
            const citations = [];

            for (const fileId of citationIds.slice(0, 12)) {
                try {
                    const cite = await lookupCitationByFileId(fileId);
                    if (cite) citations.push(cite);
                } catch (e) {
                    citations.push({
                        id: fileId,
                        authors: 'Unknown Author',
                        year: 'n.d.',
                        title: 'Unknown Title',
                        pageUrl: '',
                        apa7: 'Source unavailable'
                    });
                }
            }

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content,
                    citations,
                    vectorStoreId: vectorStoreId
                })
            };
        } catch (error) {
            context.error('[KB RAG Chat] Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'KB RAG request failed', details: error.message })
            };
        }
    }
});

app.http('KBRagChatStream', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'kb/rag-chat/stream',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const query = (body?.query || body?.message || '').toString().trim();
            const chatId = (body?.chatId || '').toString().trim();
            const useReasoning = Boolean(body?.reasoning);
            const reasoningEffort = (process.env.OPENAI_REASONING_EFFORT || '').toString().trim();
            const systemPrompt = await getSystemPrompt(context);

            if (!query) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'query is required' })
                };
            }

            if (!process.env.OPENAI_API_KEY) {
                return {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'OpenAI API key not configured' })
                };
            }

            const vectorStoreId = process.env.OPENAI_VECTOR_STORE;
            if (!vectorStoreId) {
                return {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'OPENAI_VECTOR_STORE environment variable not configured' })
                };
            }

            const model = (process.env.OPENAI_MODEL || '').toString().trim();
            if (!model) {
                return {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'OPENAI_MODEL environment variable not configured' })
                };
            }

            const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

            let historyText = '';
            if (chatId) {
                const chat = await getItem(CONTAINER_CHATS, chatId, chatId);
                if (chat && Array.isArray(chat.messages) && chat.messages.length > 0) {
                    const recent = chat.messages.slice(-12);
                    historyText = recent
                        .map(m => `${(m.role || 'user').toUpperCase()}: ${(m.content || '').toString()}`)
                        .join('\n');
                }
            }

            const input = [
                systemPrompt,
                'You are a research assistant. Answer using ONLY the provided file search results from the user\'s academic corpus.',
                'When you make a claim that is supported by a source, append a citation marker in the exact form {{cite:FILE_ID}} where FILE_ID is the OpenAI file id for that source.',
                'Keep answers concise but academically rigorous.',
                historyText ? `Conversation so far:\n${historyText}` : '',
                `User question: ${query}`
            ].filter(Boolean).join('\n\n');

            const basePayload = {
                model,
                input,
                tools: [
                    {
                        type: 'file_search',
                        vector_store_ids: [vectorStoreId]
                    }
                ]
            };

            const { ReadableStream } = require('stream/web');
            const encoder = new TextEncoder();

            const stream = new ReadableStream({
                start(controller) {
                    const send = (eventName, data) => {
                        if (eventName) {
                            controller.enqueue(encoder.encode(`event: ${eventName}\n`));
                        }
                        const payload = typeof data === 'string' ? data : JSON.stringify(data);
                        const lines = payload.split(/\r?\n/);
                        for (const line of lines) {
                            controller.enqueue(encoder.encode(`data: ${line}\n`));
                        }
                        controller.enqueue(encoder.encode(`\n`));
                    };

                    (async () => {
                        let fullText = '';
                        try {
                            let openaiStream;
                            try {
                                openaiStream = await openai.responses.create({
                                    ...basePayload,
                                    stream: true,
                                    ...(useReasoning && reasoningEffort ? { reasoning_effort: reasoningEffort } : {})
                                });
                            } catch (err) {
                                const msg = (err && err.message) ? err.message : String(err);
                                if (useReasoning && reasoningEffort) {
                                    context.warn('[KB RAG Stream] reasoning_effort rejected; retrying without it. Error:', msg);
                                    openaiStream = await openai.responses.create({ ...basePayload, stream: true });
                                } else {
                                    throw err;
                                }
                            }

                            for await (const event of openaiStream) {
                                if (event?.type === 'response.output_text.delta' && typeof event?.delta === 'string') {
                                    fullText += event.delta;
                                    send('delta', event.delta);
                                }
                            }

                            const citationIds = extractCitationIds(fullText);
                            const citations = [];
                            for (const fileId of citationIds.slice(0, 12)) {
                                try {
                                    const cite = await lookupCitationByFileId(fileId);
                                    if (cite) citations.push(cite);
                                } catch (e) {
                                    citations.push({
                                        id: fileId,
                                        authors: 'Unknown Author',
                                        year: 'n.d.',
                                        title: 'Unknown Title',
                                        pageUrl: '',
                                        apa7: 'Source unavailable'
                                    });
                                }
                            }

                            send('done', { content: fullText, citations });
                            controller.close();
                        } catch (err) {
                            send('error', { error: 'KB RAG stream failed', details: err?.message || String(err) });
                            controller.close();
                        }
                    })();
                }
            });

            return {
                status: 200,
                enableContentNegotiation: false,
                headers: {
                    'Content-Type': 'text/event-stream; charset=utf-8',
                    'Cache-Control': 'no-cache, no-transform',
                    'Connection': 'keep-alive'
                },
                body: stream
            };
        } catch (error) {
            context.error('[KB RAG Chat Stream] Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'KB RAG stream setup failed', details: error.message })
            };
        }
    }
});
