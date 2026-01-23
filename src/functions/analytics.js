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

// POST /api/analytics/analyze - Analyze references corpus
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
            
            // Extract methods from design/analysis fields
            const methodCounts = {};
            const subjectCounts = {};
            const disciplineCounts = {};
            const typeCounts = {};
            const yearCounts = {};
            
            references.forEach(ref => {
                // Count types
                if (ref.type) {
                    typeCounts[ref.type] = (typeCounts[ref.type] || 0) + 1;
                }
                
                // Count years
                if (ref.year) {
                    yearCounts[ref.year] = (yearCounts[ref.year] || 0) + 1;
                }
                
                // Count disciplines
                if (ref.discipline) {
                    disciplineCounts[ref.discipline] = (disciplineCounts[ref.discipline] || 0) + 1;
                }
                
                // Extract methods from design field
                if (ref.design) {
                    const methodKeywords = ['qualitative', 'quantitative', 'mixed methods', 'case study', 
                        'ethnography', 'survey', 'interview', 'content analysis', 'discourse analysis',
                        'grounded theory', 'action research', 'experimental', 'longitudinal', 'cross-sectional'];
                    const designLower = ref.design.toLowerCase();
                    methodKeywords.forEach(method => {
                        if (designLower.includes(method)) {
                            methodCounts[method] = (methodCounts[method] || 0) + 1;
                        }
                    });
                }
                
                // Extract subjects from keywords/tags
                const keywords = (ref.keywords || '') + ',' + (ref.tags || '');
                keywords.split(',').forEach(kw => {
                    const cleaned = kw.trim().toLowerCase();
                    if (cleaned.length > 2 && cleaned.length < 40) {
                        subjectCounts[cleaned] = (subjectCounts[cleaned] || 0) + 1;
                    }
                });
            });
            
            // Convert to arrays sorted by count
            const methods = Object.entries(methodCounts)
                .map(([name, count]) => ({ name, count }))
                .sort((a, b) => b.count - a.count);
            
            const subjects = Object.entries(subjectCounts)
                .map(([name, count]) => ({ name, count }))
                .sort((a, b) => b.count - a.count)
                .slice(0, 20); // Top 20 subjects
            
            // Generate insights text
            const topDisciplines = Object.entries(disciplineCounts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3)
                .map(([name]) => name);
            
            const insights = `Your corpus contains ${references.length} references spanning ${Object.keys(yearCounts).length} years. ` +
                `Primary disciplines: ${topDisciplines.join(', ') || 'Not categorized'}. ` +
                `Most common types: ${Object.entries(typeCounts).sort((a,b) => b[1]-a[1]).slice(0,3).map(([t]) => t).join(', ') || 'Various'}.`;
            
            // Identify potential gaps (simplified heuristic)
            const gaps = [];
            const expectedMethods = ['qualitative', 'quantitative', 'mixed methods'];
            expectedMethods.forEach(method => {
                if (!methodCounts[method] || methodCounts[method] < 3) {
                    gaps.push({
                        name: `Limited ${method} research`,
                        description: `Consider adding more ${method} studies to strengthen methodological diversity.`,
                        severity: methodCounts[method] ? 0.4 : 0.7,
                        connectedDomains: topDisciplines
                    });
                }
            });
            
            const analysis = {
                id: `analytics_${Date.now()}`,
                dateGenerated: new Date().toISOString(),
                timestamp: new Date().toISOString(),
                referenceCount: references.length,
                totalReferences: references.length,
                insights,
                methods,
                subjects,
                gaps,
                byType: typeCounts,
                byYear: yearCounts,
                byDiscipline: disciplineCounts
            };
            
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
