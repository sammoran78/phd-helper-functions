/**
 * Journal/Notes Azure Functions
 * Save and retrieve journal entries from CosmosDB
 */

const { app } = require('@azure/functions');
const { queryItems, createItem, getItem, deleteItem } = require('../../shared/cosmosClient');
const crypto = require('crypto');

const CONTAINER_NAME = process.env.COSMOSDB_CONTAINER_COMMENTS || 'comments';

// GET /api/journal/entries - Get all journal entries (filtered by privacy)
app.http('GetJournalEntries', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'journal/entries',
    handler: async (request, context) => {
        try {
            // Get requesting user from query param or header
            const requestingUser = request.query.get('user') || request.headers.get('x-user-email') || '';
            
            context.log(`[Journal] Fetching entries for user: ${requestingUser || 'anonymous'}`);
            
            // Query all entries, ordered by timestamp descending
            const querySpec = {
                query: 'SELECT * FROM c WHERE c.type = "journal_entry" ORDER BY c.timestamp DESC'
            };
            
            const allEntries = await queryItems(CONTAINER_NAME, querySpec);
            
            // Filter: show public entries + private entries only if user is author
            const visibleEntries = allEntries.filter(entry => {
                if (!entry.isPrivate) return true;
                // Private entry: only visible to author
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
                        isPrivate: e.isPrivate || false
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
            const body = await request.json();
            const { content, author, authorEmail, isPrivate } = body;
            
            if (!content || !content.trim()) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ success: false, error: 'Content is required' })
                };
            }
            
            if (!author || !authorEmail) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ success: false, error: 'Author information is required' })
                };
            }
            
            const entryId = `journal_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
            const timestamp = new Date().toISOString();
            
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
                        isPrivate: created.isPrivate
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
            const entryId = request.params.id;
            const requestingUser = request.query.get('user') || request.headers.get('x-user-email') || '';
            
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
