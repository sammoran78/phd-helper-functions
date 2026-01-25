const { app } = require('@azure/functions');
const { queryItems, createItem, getItem, upsertItem, deleteItem } = require('../../shared/cosmosClient');

const CONTAINER_NAME = process.env.COSMOSDB_CONTAINER_REFERENCES || 'references';
const SHORTLIST_CONTAINER = process.env.COSMOSDB_CONTAINER_ANALYTICS || 'analytics';
const SHORTLIST_ID = 'shortlist';

const normalizeValue = (value) => (value || '').toString().trim().toLowerCase();

const getReferenceKeys = (reference) => {
    const doiKey = normalizeValue(reference?.doi);
    const titleKey = normalizeValue(reference?.title);
    return { doiKey, titleKey };
};

const removeFromShortlistByKeys = async (doiKey, titleKey, context) => {
    if (!doiKey && !titleKey) return;
    const shortlistDoc = await getItem(SHORTLIST_CONTAINER, SHORTLIST_ID, SHORTLIST_ID);
    if (!shortlistDoc || !Array.isArray(shortlistDoc.articles)) return;

    const filtered = shortlistDoc.articles.filter(article => {
        const articleDoiKey = normalizeValue(article?.doiKey || article?.doi);
        const articleTitleKey = normalizeValue(article?.titleKey || article?.title);
        if (doiKey && articleDoiKey === doiKey) return false;
        if (titleKey && articleTitleKey === titleKey) return false;
        return true;
    });

    if (filtered.length !== shortlistDoc.articles.length) {
        shortlistDoc.articles = filtered;
        await upsertItem(SHORTLIST_CONTAINER, shortlistDoc);
        context?.log('Removed reference from shortlist');
    }
};

// GET /api/references - Get all references
app.http('GetReferences', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'references',
    handler: async (request, context) => {
        try {
            context.log('Loading references from CosmosDB');
            
            const querySpec = {
                query: 'SELECT * FROM c WHERE (NOT IS_DEFINED(c.dismissed) OR c.dismissed != true) ORDER BY c._ts DESC'
            };
            
            const references = await queryItems(CONTAINER_NAME, querySpec);
            
            context.log(`Loaded ${references.length} references`);
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(references)
            };
        } catch (error) {
            context.error('Get References Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to load references', details: error.message })
            };
        }
    }
});

// POST /api/references - Create a new reference
app.http('CreateReference', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'references',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            
            const newReference = {
                id: `ref_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                ...body,
                dateAdded: new Date().toISOString()
            };
            
            const created = await createItem(CONTAINER_NAME, newReference);

            const { doiKey, titleKey } = getReferenceKeys(created);
            await removeFromShortlistByKeys(doiKey, titleKey, context);
            
            context.log(`Created reference: ${created.id}`);
            
            return {
                status: 201,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(created)
            };
        } catch (error) {
            context.error('Create Reference Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to create reference', details: error.message })
            };
        }
    }
});

// PUT /api/references/{id} - Update a reference
app.http('UpdateReference', {
    methods: ['PUT'],
    authLevel: 'anonymous',
    route: 'references/{id}',
    handler: async (request, context) => {
        try {
            const id = request.params.id;
            const body = await request.json();
            
            const existing = await getItem(CONTAINER_NAME, id, id);
            if (!existing) {
                return {
                    status: 404,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Reference not found' })
                };
            }
            
            const updatedReference = {
                ...existing,
                ...body,
                id: id,
                dateModified: new Date().toISOString()
            };
            
            const updated = await upsertItem(CONTAINER_NAME, updatedReference);

            const existingKeys = getReferenceKeys(existing);
            const updatedKeys = getReferenceKeys(updatedReference);
            await removeFromShortlistByKeys(existingKeys.doiKey, existingKeys.titleKey, context);
            await removeFromShortlistByKeys(updatedKeys.doiKey, updatedKeys.titleKey, context);
            
            context.log(`Updated reference: ${id}`);
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updated)
            };
        } catch (error) {
            context.error('Update Reference Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to update reference', details: error.message })
            };
        }
    }
});

// DELETE /api/references/{id} - Delete a reference
app.http('DeleteReference', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'references/{id}',
    handler: async (request, context) => {
        try {
            const id = request.params.id;
            
            await deleteItem(CONTAINER_NAME, id, id);
            
            context.log(`Deleted reference: ${id}`);
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true, message: 'Reference deleted' })
            };
        } catch (error) {
            context.error('Delete Reference Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to delete reference', details: error.message })
            };
        }
    }
});
