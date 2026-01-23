/**
 * Analytics Azure Functions
 * Store, retrieve, and update analytics data in CosmosDB
 */

const { app } = require('@azure/functions');
const { getItem, upsertItem, queryItems } = require('../../shared/cosmosClient');

const CONTAINER_NAME = process.env.COSMOSDB_CONTAINER_ANALYTICS || 'analytics';

// GET /api/analytics - Get latest analytics
app.http('GetAnalytics', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'analytics',
    handler: async (request, context) => {
        try {
            // Query for the most recent analytics record
            const query = 'SELECT * FROM c ORDER BY c.dateGenerated DESC OFFSET 0 LIMIT 1';
            const results = await queryItems(CONTAINER_NAME, query);
            
            if (results.length === 0) {
                return {
                    status: 404,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'No analytics data found' })
                };
            }
            
            context.log('Retrieved analytics');
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(results[0])
            };
        } catch (error) {
            context.error('Get Analytics Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to retrieve analytics', details: error.message })
            };
        }
    }
});

// POST /api/analytics - Create or update analytics
app.http('UpsertAnalytics', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'analytics',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            
            // Generate ID based on timestamp or use provided ID
            const id = body.id || `analytics_${Date.now()}`;
            
            const analyticsData = {
                id,
                ...body,
                dateGenerated: body.dateGenerated || new Date().toISOString()
            };
            
            const result = await upsertItem(CONTAINER_NAME, id, analyticsData);
            
            context.log(`Upserted analytics: ${id}`);
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(result)
            };
        } catch (error) {
            context.error('Upsert Analytics Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to save analytics', details: error.message })
            };
        }
    }
});

// POST /api/analytics/analyze - Analyze references corpus (placeholder for AI analysis)
app.http('AnalyzeCorpus', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'analytics/analyze',
    handler: async (request, context) => {
        try {
            // Get all references from CosmosDB
            const referencesContainer = process.env.COSMOSDB_CONTAINER_REFERENCES || 'references';
            const references = await queryItems(referencesContainer, 'SELECT * FROM c');
            
            context.log(`Analyzing ${references.length} references`);
            
            // Basic analysis (placeholder - can be enhanced with actual AI later)
            const analysis = {
                id: `analytics_${Date.now()}`,
                dateGenerated: new Date().toISOString(),
                timestamp: new Date().toISOString(),
                totalReferences: references.length,
                byType: {},
                byYear: {},
                byDiscipline: {},
                gaps: [],
                subjects: [],
                methods: []
            };
            
            // Count by type, year, discipline
            references.forEach(ref => {
                if (ref.type) {
                    analysis.byType[ref.type] = (analysis.byType[ref.type] || 0) + 1;
                }
                if (ref.year) {
                    analysis.byYear[ref.year] = (analysis.byYear[ref.year] || 0) + 1;
                }
                if (ref.discipline) {
                    analysis.byDiscipline[ref.discipline] = (analysis.byDiscipline[ref.discipline] || 0) + 1;
                }
            });
            
            // Save to CosmosDB
            await upsertItem(CONTAINER_NAME, analysis);
            
            context.log('Analysis complete and saved');
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(analysis)
            };
        } catch (error) {
            context.error('Analyze Corpus Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to analyze corpus', details: error.message })
            };
        }
    }
});

// GET /api/analytics/history - Get analytics history
app.http('GetAnalyticsHistory', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'analytics/history',
    handler: async (request, context) => {
        try {
            const url = new URL(request.url);
            const limit = parseInt(url.searchParams.get('limit') || '10');
            
            const query = `SELECT * FROM c ORDER BY c.dateGenerated DESC OFFSET 0 LIMIT ${limit}`;
            const results = await queryItems(CONTAINER_NAME, query);
            
            context.log(`Retrieved ${results.length} analytics records`);
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(results)
            };
        } catch (error) {
            context.error('Get Analytics History Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to retrieve analytics history', details: error.message })
            };
        }
    }
});

module.exports = { app };
