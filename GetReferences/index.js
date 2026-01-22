const { app } = require('@azure/functions');
const { queryItems } = require('../shared/cosmosClient');

app.http('GetReferences', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'references',
    handler: async (request, context) => {
        try {
            context.log('Loading references from CosmosDB');
            
            const containerName = process.env.COSMOSDB_CONTAINER_REFERENCES || 'references';
            
            const querySpec = {
                query: 'SELECT * FROM c ORDER BY c._ts DESC'
            };
            
            const references = await queryItems(containerName, querySpec);
            
            context.log(`Loaded ${references.length} references`);
            
            return {
                status: 200,
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(references)
            };
        } catch (error) {
            context.error('Get References Error:', error);
            return {
                status: 500,
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ error: 'Failed to load references', details: error.message })
            };
        }
    }
});
