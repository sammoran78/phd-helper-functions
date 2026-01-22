const { app } = require('@azure/functions');
const { deleteItem, getItem } = require('../shared/cosmosClient');

app.http('DeleteReference', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'references/{id}',
    handler: async (request, context) => {
        try {
            const id = request.params.id;
            
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
            
            await deleteItem(containerName, id, id);
            
            context.log(`Deleted reference: ${id}`);
            
            return {
                status: 200,
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ success: true })
            };
        } catch (error) {
            context.error('Delete Reference Error:', error);
            return {
                status: 500,
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ error: 'Failed to delete reference', details: error.message })
            };
        }
    }
});
