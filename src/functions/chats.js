const { app } = require('@azure/functions');
const { queryItems, createItem, getItem, upsertItem, deleteItem } = require('../../shared/cosmosClient');

const CONTAINER_NAME = process.env.COSMOSDB_CONTAINER_CHATS || 'chats';
const SYSTEM_PROMPT_DOC_ID = process.env.COSMOSDB_SYSTEM_PROMPT_ID || 'kb_system_prompt';
const CHAT_MAX_MESSAGES = parsePositiveInt(process.env.CHAT_MAX_MESSAGES, 60);
const CHAT_MAX_CONTENT_CHARS = parsePositiveInt(process.env.CHAT_MAX_CONTENT_CHARS, 180000);
const CHAT_MAX_CITATIONS_PER_MESSAGE = parsePositiveInt(process.env.CHAT_MAX_CITATIONS_PER_MESSAGE, 12);

function parsePositiveInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sanitizeMessageForStorage(message) {
    return {
        ...message,
        content: (message?.content || '').toString(),
        citations: Array.isArray(message?.citations) ? message.citations.slice(0, CHAT_MAX_CITATIONS_PER_MESSAGE) : []
    };
}

function trimMessagesForStorage(messages) {
    const sanitized = (Array.isArray(messages) ? messages : []).map(sanitizeMessageForStorage);
    const cappedByCount = sanitized.slice(-CHAT_MAX_MESSAGES);
    const selected = [];
    let totalChars = 0;

    for (let i = cappedByCount.length - 1; i >= 0; i -= 1) {
        const msg = cappedByCount[i];
        const contentChars = (msg.content || '').length;
        if (selected.length > 0 && (totalChars + contentChars) > CHAT_MAX_CONTENT_CHARS) {
            break;
        }
        selected.push(msg);
        totalChars += contentChars;
    }

    return selected.reverse();
}

// GET /api/chats - Get all chat conversations
app.http('GetChats', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'chats',
    handler: async (request, context) => {
        try {
            context.log('Loading chat conversations from CosmosDB');
            
            const querySpec = {
                query: 'SELECT c.id, c.title, c.type, c.createdAt, c.updatedAt, c.messageCount FROM c WHERE c.id != @promptId ORDER BY c.updatedAt DESC',
                parameters: [{ name: '@promptId', value: SYSTEM_PROMPT_DOC_ID }]
            };
            
            const chats = await queryItems(CONTAINER_NAME, querySpec);
            
            context.log(`Loaded ${chats.length} chat conversations`);
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(chats)
            };
        } catch (error) {
            context.error('Get Chats Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to load chats', details: error.message })
            };
        }
    }
});

// GET /api/chats/{id} - Get a single chat with all messages
app.http('GetChat', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'chats/{id}',
    handler: async (request, context) => {
        try {
            const id = request.params.id;
            context.log(`Loading chat: ${id}`);
            
            const chat = await getItem(CONTAINER_NAME, id, id);
            
            if (!chat) {
                return {
                    status: 404,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Chat not found' })
                };
            }
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(chat)
            };
        } catch (error) {
            context.error('Get Chat Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to load chat', details: error.message })
            };
        }
    }
});

// POST /api/chats - Create a new chat conversation
app.http('CreateChat', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'chats',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const initialMessages = trimMessagesForStorage(body.messages || []);
            
            const newChat = {
                id: `chat_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                type: (body.type || 'chat').toString().trim() || 'chat',
                title: body.title || 'New Conversation',
                messages: initialMessages,
                messageCount: initialMessages.length,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
            
            const created = await createItem(CONTAINER_NAME, newChat);
            
            context.log(`Created chat: ${created.id}`);
            
            return {
                status: 201,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(created)
            };
        } catch (error) {
            context.error('Create Chat Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to create chat', details: error.message })
            };
        }
    }
});

// PUT /api/chats/{id} - Update a chat (add messages, update title)
app.http('UpdateChat', {
    methods: ['PUT'],
    authLevel: 'anonymous',
    route: 'chats/{id}',
    handler: async (request, context) => {
        try {
            const id = request.params.id;
            const body = await request.json();
            
            const existing = await getItem(CONTAINER_NAME, id, id);
            if (!existing) {
                return {
                    status: 404,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Chat not found' })
                };
            }
            
            const storedMessages = body.messages
                ? trimMessagesForStorage(body.messages)
                : trimMessagesForStorage(existing.messages || []);

            const updatedChat = {
                ...existing,
                ...body,
                id: id,
                type: existing.type || body.type || 'chat',
                messages: storedMessages,
                messageCount: storedMessages.length,
                updatedAt: new Date().toISOString()
            };
            
            const updated = await upsertItem(CONTAINER_NAME, updatedChat);
            
            context.log(`Updated chat: ${id}`);
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updated)
            };
        } catch (error) {
            context.error('Update Chat Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to update chat', details: error.message })
            };
        }
    }
});

// POST /api/chats/{id}/message - Add a message to a chat
app.http('AddChatMessage', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'chats/{id}/message',
    handler: async (request, context) => {
        try {
            const id = request.params.id;
            const body = await request.json();
            
            const existing = await getItem(CONTAINER_NAME, id, id);
            if (!existing) {
                return {
                    status: 404,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Chat not found' })
                };
            }
            
            const newMessage = sanitizeMessageForStorage({
                id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                role: body.role || 'user',
                content: body.content || '',
                citations: body.citations || [],
                timestamp: new Date().toISOString()
            });
            
            const messages = trimMessagesForStorage([...(existing.messages || []), newMessage]);
            
            const updatedChat = {
                ...existing,
                type: existing.type || 'chat',
                messages: messages,
                messageCount: messages.length,
                updatedAt: new Date().toISOString()
            };
            
            // Auto-generate title from first user message if still default
            if (updatedChat.title === 'New Conversation' && body.role === 'user' && body.content) {
                updatedChat.title = body.content.substring(0, 50) + (body.content.length > 50 ? '...' : '');
            }
            
            const updated = await upsertItem(CONTAINER_NAME, updatedChat);
            
            context.log(`Added message to chat: ${id}`);
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat: updated, message: newMessage })
            };
        } catch (error) {
            context.error('Add Chat Message Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to add message', details: error.message })
            };
        }
    }
});

// DELETE /api/chats/{id} - Delete a chat conversation
app.http('DeleteChat', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'chats/{id}',
    handler: async (request, context) => {
        try {
            const id = request.params.id;
            
            await deleteItem(CONTAINER_NAME, id, id);
            
            context.log(`Deleted chat: ${id}`);
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true, message: 'Chat deleted' })
            };
        } catch (error) {
            context.error('Delete Chat Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to delete chat', details: error.message })
            };
        }
    }
});
