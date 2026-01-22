const { app } = require('@azure/functions');
const { createItem } = require('../shared/cosmosClient');
const crypto = require('crypto');

app.http('CreateReference', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'references',
    handler: async (request, context) => {
        try {
            const newRef = await request.json();
            
            if (!newRef.id) {
                newRef.id = crypto.randomUUID();
            }
            newRef.dateAdded = new Date().toISOString();
            
            const containerName = process.env.COSMOSDB_CONTAINER_REFERENCES || 'references';
            
            const created = await createItem(containerName, newRef);
            
            context.log(`Created reference: ${created.id}`);
            
            return {
                status: 200,
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ success: true, reference: created })
            };
        } catch (error) {
            context.error('Create Reference Error:', error);
            return {
                status: 500,
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ error: 'Failed to save reference', details: error.message })
            };
        }
    }
});
