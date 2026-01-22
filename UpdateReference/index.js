const { app } = require('@azure/functions');
const { getItem, replaceItem } = require('../shared/cosmosClient');

app.http('UpdateReference', {
    methods: ['PUT'],
    authLevel: 'anonymous',
    route: 'references/{id}',
    handler: async (request, context) => {
        try {
            const id = request.params.id;
            const updatedRef = await request.json();
            
            const containerName = process.env.COSMOSDB_CONTAINER_REFERENCES || 'references';
            
            const existing = await getItem(containerName, id, id);
            
            if (!existing) {
                return {
                    status: 404,
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ error: 'Reference not found' })
                };
            }
            
            const merged = { ...existing, ...updatedRef, id };
            
            const updated = await replaceItem(containerName, id, id, merged);
            
            context.log(`Updated reference: ${id}`);
            
            return {
                status: 200,
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ success: true, reference: updated })
            };
        } catch (error) {
            context.error('Update Reference Error:', error);
            return {
                status: 500,
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ error: 'Failed to update reference', details: error.message })
            };
        }
    }
});
