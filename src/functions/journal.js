/**
 * Journal/Notes Azure Functions
 * Save and retrieve journal entries from CosmosDB
 */

const { app } = require('@azure/functions');
const { queryItems, createItem, getItem, deleteItem } = require('../../shared/cosmosClient');
const crypto = require('crypto');

const CONTAINER_NAME = process.env.COSMOSDB_CONTAINER_COMMENTS || 'comments';

function base64UrlEncode(value) {
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return buf
        .toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
}

function base64UrlDecodeToString(value) {
    const s = (value || '').toString().replace(/-/g, '+').replace(/_/g, '/');
    const pad = '='.repeat((4 - (s.length % 4)) % 4);
    return Buffer.from(s + pad, 'base64').toString('utf8');
}

function getAuthUser(request) {
    try {
        const header = request.headers.get('authorization') || '';
        const m = header.match(/^Bearer\s+(.+)$/i);
        if (!m) return null;

        const token = m[1];
        const parts = token.split('.');
        if (parts.length !== 3) return null;

        const [headerB64, payloadB64, sigB64] = parts;
        const data = `${headerB64}.${payloadB64}`;
        const secret = process.env.AUTH_JWT_SECRET || 'dev-secret-change-me';

        const expectedSig = base64UrlEncode(
            crypto.createHmac('sha256', secret).update(data).digest()
        );

        if (expectedSig !== sigB64) return null;

        const payloadJson = base64UrlDecodeToString(payloadB64);
        const payload = JSON.parse(payloadJson);
        if (payload?.exp && payload.exp < Date.now() / 1000) return null;
        if (!payload?.email) return null;
        return payload;
    } catch {
        return null;
    }
}

// GET /api/journal/entries - Get all journal entries (filtered by privacy)
app.http('GetJournalEntries', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'journal/entries',
    handler: async (request, context) => {
        try {
            const authUser = getAuthUser(request);
            const requestingUser = authUser?.email || '';

            if (!requestingUser) {
                return {
                    status: 401,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ success: false, error: 'Unauthorized' })
                };
            }

            context.log(`[Journal] Fetching entries for user: ${requestingUser || 'anonymous'}`);
            
            // Query all entries, ordered by timestamp descending
            const querySpec = {
                query: 'SELECT * FROM c WHERE c.type = "journal_entry" ORDER BY c.timestamp DESC'
            };
            
            const allEntries = await queryItems(CONTAINER_NAME, querySpec);
            
            // Filter: show public entries + private entries only if user is author
            const visibleEntries = allEntries.filter(entry => {
                if (!entry?.isPrivate) return true;
                if (!requestingUser) return false;
                return entry.authorEmail && entry.authorEmail.toLowerCase() === requestingUser.toLowerCase();
            });
            
            context.log(`[Journal] Returning ${visibleEntries.length} of ${allEntries.length} entries`);
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    success: true,
                    entries: visibleEntries.map(e => ({
                        id: e.id,
                        content: e.content,
                        author: e.author,
                        authorEmail: e.authorEmail,
                        timestamp: e.timestamp,
                        isPrivate: e.isPrivate || false,
                        canDelete: !!(requestingUser && e.authorEmail && e.authorEmail.toLowerCase() === requestingUser.toLowerCase())
                    }))
                })
            };
        } catch (error) {
            context.error('[Journal] GetJournalEntries Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: false, error: error.message })
            };
        }
    }
});

// POST /api/journal/entry - Create a new journal entry
app.http('CreateJournalEntry', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'journal/entry',
    handler: async (request, context) => {
        try {
            const authUser = getAuthUser(request);
            if (!authUser) {
                return {
                    status: 401,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ success: false, error: 'Unauthorized' })
                };
            }

            const body = await request.json();
            const { content, isPrivate } = body;
            
            if (!content || !content.trim()) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ success: false, error: 'Content is required' })
                };
            }
            
            const entryId = `journal_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
            const timestamp = new Date().toISOString();

            const author = authUser.name || authUser.email || 'User';
            const authorEmail = authUser.email;
            
            const entry = {
                id: entryId,
                type: 'journal_entry',
                content: content.trim(),
                author: author,
                authorEmail: authorEmail.toLowerCase(),
                isPrivate: isPrivate === true,
                timestamp: timestamp,
                createdAt: timestamp
            };
            
            context.log(`[Journal] Creating entry: ${entryId} by ${author} (private: ${entry.isPrivate})`);
            
            const created = await createItem(CONTAINER_NAME, entry);
            
            return {
                status: 201,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    success: true,
                    entry: {
                        id: created.id,
                        content: created.content,
                        author: created.author,
                        authorEmail: created.authorEmail,
                        timestamp: created.timestamp,
                        isPrivate: created.isPrivate,
                        canDelete: true
                    }
                })
            };
        } catch (error) {
            context.error('[Journal] CreateJournalEntry Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: false, error: error.message })
            };
        }
    }
});

// DELETE /api/journal/entry/{id} - Delete a journal entry (only by author)
app.http('DeleteJournalEntry', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'journal/entry/{id}',
    handler: async (request, context) => {
        try {
            const authUser = getAuthUser(request);
            if (!authUser) {
                return {
                    status: 401,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ success: false, error: 'Unauthorized' })
                };
            }

            const entryId = request.params.id;
            const requestingUser = authUser.email || '';
            
            if (!entryId) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ success: false, error: 'Entry ID is required' })
                };
            }
            
            // Get the entry first to check ownership
            const entry = await getItem(CONTAINER_NAME, entryId, entryId);
            
            if (!entry) {
                return {
                    status: 404,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ success: false, error: 'Entry not found' })
                };
            }
            
            // Check if requesting user is the author
            if (entry.authorEmail && entry.authorEmail.toLowerCase() !== requestingUser.toLowerCase()) {
                return {
                    status: 403,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ success: false, error: 'You can only delete your own entries' })
                };
            }
            
            context.log(`[Journal] Deleting entry: ${entryId} by ${requestingUser}`);
            
            await deleteItem(CONTAINER_NAME, entryId, entryId);
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true, message: 'Entry deleted' })
            };
        } catch (error) {
            context.error('[Journal] DeleteJournalEntry Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: false, error: error.message })
            };
        }
    }
});
