/**
 * Analytics Azure Functions
 * Store, retrieve, and update analytics data in CosmosDB
 */

const { app } = require('@azure/functions');
const { getItem, upsertItem, queryItems } = require('../../shared/cosmosClient');

const CONTAINER_NAME = process.env.COSMOSDB_CONTAINER_ANALYTICS || 'analytics';
const REFERENCES_CONTAINER = process.env.COSMOSDB_CONTAINER_REFERENCES || 'references';
const LANDSCAPE_DOC_ID = 'analytics_landscape';
const LANDSCAPE_TTL_MS = 24 * 60 * 60 * 1000;

const isLandscapeStale = (dateGenerated) => {
    if (!dateGenerated) return true;
    const timestamp = new Date(dateGenerated).getTime();
    if (Number.isNaN(timestamp)) return true;
    return Date.now() - timestamp > LANDSCAPE_TTL_MS;
};

const toLandscapeReference = (ref) => ({
    id: ref.id,
    title: ref.title,
    authors: ref.authors,
    year: ref.year,
    source: ref.source,
    tags: ref.tags,
    keywords: ref.keywords,
    discipline: ref.discipline,
    frameworks: ref.frameworks,
    concepts: ref.concepts,
    summary: ref.summary
});

const buildLandscapeSnapshot = async (context) => {
    const query = 'SELECT * FROM c WHERE NOT IS_DEFINED(c.dismissed) OR c.dismissed != true';
    const references = await queryItems(REFERENCES_CONTAINER, { query });
    const snapshot = {
        id: LANDSCAPE_DOC_ID,
        type: 'landscape',
        dateGenerated: new Date().toISOString(),
        referenceCount: references.length,
        references: references.map(toLandscapeReference)
    };

    await upsertItem(CONTAINER_NAME, snapshot);
    context?.log(`Saved analytics landscape snapshot with ${references.length} references`);
    return snapshot;
};

// GET /api/analytics/landscape - Get cached landscape snapshot (refresh daily or manually)
app.http('GetAnalyticsLandscape', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'analytics/landscape',
    handler: async (request, context) => {
        try {
            const url = new URL(request.url);
            const refreshParam = url.searchParams.get('refresh');
            const forceRefresh = refreshParam === 'true' || refreshParam === '1';

            let snapshot = await getItem(CONTAINER_NAME, LANDSCAPE_DOC_ID, LANDSCAPE_DOC_ID);

            if (!snapshot || forceRefresh || isLandscapeStale(snapshot.dateGenerated)) {
                snapshot = await buildLandscapeSnapshot(context);
            }

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(snapshot)
            };
        } catch (error) {
            context.error('Get Analytics Landscape Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to retrieve analytics landscape', details: error.message })
            };
        }
    }
});

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
            
            const result = await upsertItem(CONTAINER_NAME, analyticsData);
            
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
            const references = await queryItems(REFERENCES_CONTAINER, 'SELECT * FROM c');
            
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
                
            const topDisciplines = Object.entries(disciplineCounts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3)
                .map(([name]) => name);

            let insights = '';
            let gaps = [];

            // AI Analysis (if API key present)
            if (process.env.OPENAI_API_KEY) {
                try {
                    const OpenAI = require('openai');
                    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
                    
                    // Prepare reference summaries for AI
                    const refSummaries = references.slice(0, 100).map(r => 
                        `- ${r.title} (${r.year}): ${r.design || 'No method'} | ${r.discipline || 'No discipline'} | ${r.keywords || ''}`
                    ).join('\n');

                    const prompt = `
                        Analyze this academic bibliography (${references.length} references) for a PhD thesis.
                        
                        Data Summary:
                        - Disciplines: ${topDisciplines.join(', ')}
                        - Methods: ${methods.map(m => m.name).join(', ')}
                        - Key Topics: ${subjects.slice(0, 10).map(s => s.name).join(', ')}
                        
                        Bibliography Sample:
                        ${refSummaries}
                        
                        Task:
                        1. Summarize the research landscape and coverage.
                        2. Identify 3-5 critical gaps in methodology, theory, or empirical settings.
                        3. Suggest specific types of sources needed to fill these gaps.
                        
                        Output JSON format:
                        {
                            "insights": "paragraph summary...",
                            "gaps": [
                                { "name": "Gap Name", "description": "Description...", "severity": 0.8 (0-1), "connectedDomains": ["Domain1"], "searchQueries": ["query1", "query2"] }
                            ]
                        }
                    `;

                    const completion = await openai.chat.completions.create({
                        model: "gpt-4o",
                        messages: [{ role: "user", content: prompt }],
                        response_format: { type: "json_object" }
                    });

                    const aiResult = JSON.parse(completion.choices[0].message.content);
                    insights = aiResult.insights;
                    gaps = aiResult.gaps || [];
                    
                } catch (aiError) {
                    context.warn('AI Analysis failed, falling back to heuristics:', aiError.message);
                }
            }

            // Fallback Heuristics (if AI failed or no key)
            if (!insights) {
                insights = `Your corpus contains ${references.length} references spanning ${Object.keys(yearCounts).length} years. ` +
                    `Primary disciplines: ${topDisciplines.join(', ') || 'Not categorized'}. ` +
                    `Most common types: ${Object.entries(typeCounts).sort((a,b) => b[1]-a[1]).slice(0,3).map(([t]) => t).join(', ') || 'Various'}.`;
                
                // Methodology Gaps
                const expectedMethods = ['qualitative', 'quantitative', 'mixed methods'];
                expectedMethods.forEach(method => {
                    if (!methodCounts[method] || methodCounts[method] < 3) {
                        gaps.push({
                            name: `Limited ${method} research`,
                            description: `Consider adding more ${method} studies to strengthen methodological diversity.`,
                            severity: methodCounts[method] ? 0.4 : 0.7,
                            connectedDomains: topDisciplines,
                            searchQueries: [`${method} study ${topDisciplines[0] || 'research'}`, `${method} analysis ${subjects[0]?.name || ''}`]
                        });
                    }
                });
                
                // Recency Gaps
                const currentYear = new Date().getFullYear();
                const recentRefs = references.filter(r => r.year >= currentYear - 2).length;
                if (recentRefs < references.length * 0.2) {
                    gaps.push({
                        name: 'Outdated Literature',
                        description: `Only ${recentRefs} references from the last 2 years. Field is moving fast.`,
                        severity: 0.8,
                        connectedDomains: topDisciplines,
                        searchQueries: [`latest research ${subjects[0]?.name || ''} ${currentYear}`, `new developments ${topDisciplines[0] || ''}`]
                    });
                }
            }
            
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
