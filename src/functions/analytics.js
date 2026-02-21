/**
 * Analytics Azure Functions
 * Store, retrieve, and update analytics data in CosmosDB
 */

const { app } = require('@azure/functions');
const { getItem, upsertItem, queryItems } = require('../../shared/cosmosClient');

const CONTAINER_NAME = process.env.COSMOSDB_CONTAINER_ANALYTICS || 'analytics';
const REFERENCES_CONTAINER = process.env.COSMOSDB_CONTAINER_REFERENCES || 'references';
const WRITING_ANALYTICS_LATEST_ID = 'writing_analytics_latest';
const LANDSCAPE_DOC_ID = 'analytics_landscape';
const LANDSCAPE_TTL_MS = 24 * 60 * 60 * 1000;
const COFFEE_COUNTER_DOC_ID = 'coffee_counter';
const LANDSCAPE_SCOPE = 'kb_status_3_only';
const KB_REFERENCE_FILTER_CLAUSE = 'c.ref_knowledge_status = 3 AND (NOT IS_DEFINED(c.dismissed) OR c.dismissed != true)';
const LANDSCAPE_REFERENCE_QUERY = `SELECT c.id, c.title, c.authors, c.year, c.source, c.tags, c.keywords, c.discipline, c.frameworks, c.concepts, c.summary, c.design, c.analysis, c.apa7, c.journal, c.publisher, c.abstract FROM c WHERE ${KB_REFERENCE_FILTER_CLAUSE}`;
const ANALYTICS_REFERENCE_QUERY = `SELECT * FROM c WHERE ${KB_REFERENCE_FILTER_CLAUSE}`;

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
    journal: ref.journal,
    publisher: ref.publisher,
    tags: ref.tags,
    keywords: ref.keywords,
    discipline: ref.discipline,
    frameworks: ref.frameworks,
    concepts: ref.concepts,
    summary: ref.summary,
    design: ref.design,
    analysis: ref.analysis,
    apa7: ref.apa7,
    abstract: ref.abstract
});

const buildLandscapeSnapshot = async (context) => {
    const references = await queryItems(REFERENCES_CONTAINER, { query: LANDSCAPE_REFERENCE_QUERY });
    const snapshot = {
        id: LANDSCAPE_DOC_ID,
        type: 'landscape',
        scope: LANDSCAPE_SCOPE,
        dateGenerated: new Date().toISOString(),
        referenceCount: references.length,
        references: references.map(toLandscapeReference)
    };

    await upsertItem(CONTAINER_NAME, snapshot);
    context?.log(`Saved analytics landscape snapshot with ${references.length} references (scope: ${LANDSCAPE_SCOPE})`);
    return snapshot;
};

const toCounterNumber = (value) => {
    const n = typeof value === 'number' ? value : parseInt(value, 10);
    if (!Number.isFinite(n) || Number.isNaN(n)) return 0;
    return Math.max(0, Math.floor(n));
};

const getOrCreateCoffeeCounter = async (context) => {
    let existing = await getItem(CONTAINER_NAME, COFFEE_COUNTER_DOC_ID, COFFEE_COUNTER_DOC_ID);
    if (!existing) {
        existing = {
            id: COFFEE_COUNTER_DOC_ID,
            type: 'coffee_counter',
            count: 0,
            updatedAt: new Date().toISOString(),
            createdAt: new Date().toISOString()
        };
        existing = await upsertItem(CONTAINER_NAME, existing);
        context?.log('Created coffee counter document');
    }
    return existing;
};

// GET /api/analytics/coffee-counter - Get current coffee counter
app.http('GetCoffeeCounter', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'analytics/coffee-counter',
    handler: async (request, context) => {
        try {
            const counter = await getOrCreateCoffeeCounter(context);
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: COFFEE_COUNTER_DOC_ID,
                    type: 'coffee_counter',
                    count: toCounterNumber(counter.count),
                    updatedAt: counter.updatedAt,
                    createdAt: counter.createdAt
                })
            };
        } catch (error) {
            context.error('Get Coffee Counter Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to retrieve coffee counter', details: error.message })
            };
        }
    }
});

// POST /api/analytics/coffee-counter/increment - Increment coffee counter by 1
app.http('IncrementCoffeeCounter', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'analytics/coffee-counter/increment',
    handler: async (request, context) => {
        try {
            const counter = await getOrCreateCoffeeCounter(context);
            const nextCount = toCounterNumber(counter.count) + 1;
            const updated = await upsertItem(CONTAINER_NAME, {
                ...counter,
                id: COFFEE_COUNTER_DOC_ID,
                type: 'coffee_counter',
                count: nextCount,
                updatedAt: new Date().toISOString(),
                createdAt: counter.createdAt || new Date().toISOString()
            });

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: COFFEE_COUNTER_DOC_ID,
                    type: 'coffee_counter',
                    count: toCounterNumber(updated.count),
                    updatedAt: updated.updatedAt,
                    createdAt: updated.createdAt
                })
            };
        } catch (error) {
            context.error('Increment Coffee Counter Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to increment coffee counter', details: error.message })
            };
        }
    }
});

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
            const scopeMismatch = snapshot?.scope !== LANDSCAPE_SCOPE;

            if (!snapshot || forceRefresh || scopeMismatch || isLandscapeStale(snapshot.dateGenerated)) {
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
            const querySpec = {
                query: 'SELECT * FROM c WHERE c.type = "corpus_analysis" AND c.scope = @scope ORDER BY c.dateGenerated DESC OFFSET 0 LIMIT 1',
                parameters: [{ name: '@scope', value: LANDSCAPE_SCOPE }]
            };
            const results = await queryItems(CONTAINER_NAME, querySpec);
            
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
            // Analyze only references that are in the RAG knowledge base (status 3)
            const references = await queryItems(REFERENCES_CONTAINER, { query: ANALYTICS_REFERENCE_QUERY });
            
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
                type: 'corpus_analysis',
                scope: LANDSCAPE_SCOPE,
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
            
            const querySpec = {
                query: `SELECT * FROM c WHERE c.type = "corpus_analysis" ORDER BY c.dateGenerated DESC OFFSET 0 LIMIT ${limit}`
            };
            const results = await queryItems(CONTAINER_NAME, querySpec);
            
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

// Dashboard snapshot document ID
const DASHBOARD_SNAPSHOT_ID = 'dashboard_snapshot';

function getWeekChangeFromHistory(history, field, current) {
    if (!Array.isArray(history) || history.length === 0) return 0;
    const oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const weekAgoEntry = history.find(entry => {
        if (!entry || entry[field] === undefined) return false;
        const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
        return ts && ts <= oneWeekAgo;
    });
    if (!weekAgoEntry) return 0;
    return (current || 0) - (weekAgoEntry[field] || 0);
}

// GET /api/analytics/dashboard - Get dashboard stats with weekly change
app.http('GetDashboardAnalytics', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'analytics/dashboard',
    handler: async (request, context) => {
        try {
            // Get the dashboard snapshot document
            let snapshot = await getItem(CONTAINER_NAME, DASHBOARD_SNAPSHOT_ID, DASHBOARD_SNAPSHOT_ID);
            
            if (!snapshot) {
                // Return default values if no snapshot exists
                return {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        knowledgeBase: { current: 0, weekChange: 0 },
                        sourcesForReview: { current: 0, weekChange: 0 },
                        wordCount: { current: 0, weekChange: 0, target: 80000 },
                        daysToMilestone: { current: 0, milestoneName: 'No milestone set' },
                        surveyResponses: { current: 0, weekChange: 0 },
                        lastUpdated: null,
                        needsRefresh: true
                    })
                };
            }
            
            // Calculate if data is stale (older than 12 hours)
            const lastUpdated = snapshot.lastUpdated ? new Date(snapshot.lastUpdated) : null;
            const isStale = !lastUpdated || (Date.now() - lastUpdated.getTime() > 12 * 60 * 60 * 1000);
            
            // Calculate weekly changes from history
            const history = snapshot.history || [];
            
            const response = {
                knowledgeBase: {
                    current: snapshot.knowledgeBase || 0,
                    weekChange: getWeekChangeFromHistory(history, 'knowledgeBase', snapshot.knowledgeBase)
                },
                sourcesForReview: {
                    current: snapshot.sourcesForReview || 0,
                    weekChange: getWeekChangeFromHistory(history, 'sourcesForReview', snapshot.sourcesForReview)
                },
                wordCount: {
                    current: snapshot.wordCount || 0,
                    weekChange: getWeekChangeFromHistory(history, 'wordCount', snapshot.wordCount),
                    target: snapshot.wordCountTarget || 80000
                },
                daysToMilestone: {
                    current: snapshot.daysToMilestone || 0,
                    milestoneName: snapshot.milestoneName || 'Confirmation of Candidature'
                },
                surveyResponses: {
                    current: snapshot.surveyResponses || 0,
                    weekChange: getWeekChangeFromHistory(history, 'surveyResponses', snapshot.surveyResponses)
                },
                history: history,
                lastUpdated: snapshot.lastUpdated,
                needsRefresh: isStale
            };
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(response)
            };
        } catch (error) {
            context.error('Get Dashboard Analytics Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to retrieve dashboard analytics', details: error.message })
            };
        }
    }
});

// POST /api/analytics/dashboard - Update dashboard stats (appends to history)
app.http('UpdateDashboardAnalytics', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'analytics/dashboard',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const { knowledgeBase, sourcesForReview, wordCount, daysToMilestone, milestoneName, surveyResponses, wordCountTarget } = body;
            
            // Get existing snapshot or create new
            let snapshot = await getItem(CONTAINER_NAME, DASHBOARD_SNAPSHOT_ID, DASHBOARD_SNAPSHOT_ID);
            
            if (!snapshot) {
                snapshot = {
                    id: DASHBOARD_SNAPSHOT_ID,
                    history: []
                };
            }
            
            // Add current values to history (keep last 90 days of history)
            const now = new Date().toISOString();
            const historyEntry = {
                timestamp: now,
                knowledgeBase: snapshot.knowledgeBase,
                sourcesForReview: snapshot.sourcesForReview,
                wordCount: snapshot.wordCount,
                surveyResponses: snapshot.surveyResponses
            };
            
            // Only add to history if values changed or it's been > 1 hour since last entry
            const lastHistoryEntry = snapshot.history?.[0];
            const shouldAddHistory = !lastHistoryEntry || 
                (Date.now() - new Date(lastHistoryEntry.timestamp).getTime() > 60 * 60 * 1000) ||
                lastHistoryEntry.knowledgeBase !== snapshot.knowledgeBase ||
                lastHistoryEntry.sourcesForReview !== snapshot.sourcesForReview ||
                lastHistoryEntry.wordCount !== snapshot.wordCount;
            
            if (shouldAddHistory && (snapshot.knowledgeBase !== undefined || snapshot.sourcesForReview !== undefined)) {
                snapshot.history = [historyEntry, ...(snapshot.history || [])].slice(0, 90);
            }
            
            // Update current values
            if (knowledgeBase !== undefined) snapshot.knowledgeBase = knowledgeBase;
            if (sourcesForReview !== undefined) snapshot.sourcesForReview = sourcesForReview;
            if (wordCount !== undefined) snapshot.wordCount = wordCount;
            if (daysToMilestone !== undefined) snapshot.daysToMilestone = daysToMilestone;
            if (milestoneName !== undefined) snapshot.milestoneName = milestoneName;
            if (surveyResponses !== undefined) snapshot.surveyResponses = surveyResponses;
            if (wordCountTarget !== undefined) snapshot.wordCountTarget = wordCountTarget;
            
            snapshot.lastUpdated = now;
            
            // Save to CosmosDB
            await upsertItem(CONTAINER_NAME, snapshot);
            
            context.log('Dashboard analytics updated');
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true, lastUpdated: now })
            };
        } catch (error) {
            context.error('Update Dashboard Analytics Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to update dashboard analytics', details: error.message })
            };
        }
    }
});

// POST /api/analytics/dashboard/refresh - Auto-refresh dashboard stats from source data
app.http('RefreshDashboardAnalytics', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'analytics/dashboard/refresh',
    handler: async (request, context) => {
        try {
            // Fetch counts from various sources

            // 0. Count references fully vectorized into the Knowledge Base (ref_knowledge_status >= 3)
            let knowledgeBase = 0;
            try {
                const kbQuery = 'SELECT VALUE COUNT(1) FROM c WHERE c.ref_knowledge_status >= 3 AND (NOT IS_DEFINED(c.dismissed) OR c.dismissed != true)';
                const kbResult = await queryItems(REFERENCES_CONTAINER, { query: kbQuery });
                knowledgeBase = kbResult[0] || 0;
            } catch (e) {
                context.warn('Could not fetch knowledge base count:', e.message);
            }
            
            // 1. Count references still awaiting review (ref_knowledge_status < 3 or not defined)
            let sourcesForReview = 0;
            try {
                const reviewQuery = 'SELECT VALUE COUNT(1) FROM c WHERE (NOT IS_DEFINED(c.ref_knowledge_status) OR c.ref_knowledge_status < 3) AND (NOT IS_DEFINED(c.dismissed) OR c.dismissed != true)';
                const reviewResult = await queryItems(REFERENCES_CONTAINER, { query: reviewQuery });
                sourcesForReview = reviewResult[0] || 0;
            } catch (e) {
                context.warn('Could not fetch sources for review count:', e.message);
            }
            
            // 2. Get word count from Writing Analytics (look for "Working DRAFT" document)
            let wordCount = 0;
            try {
                const workingDraftId = process.env.GOOGLE_WORKING_DRAFT_ID;

                let writingDoc = await getItem(CONTAINER_NAME, WRITING_ANALYTICS_LATEST_ID, WRITING_ANALYTICS_LATEST_ID);
                if (!writingDoc) {
                    const writingQuery = 'SELECT * FROM c WHERE c.type = "writing_analytics" ORDER BY c._ts DESC OFFSET 0 LIMIT 1';
                    const writingResult = await queryItems(CONTAINER_NAME, { query: writingQuery });
                    writingDoc = writingResult.length > 0 ? writingResult[0] : null;
                }

                const documents = Array.isArray(writingDoc?.documents) ? writingDoc.documents : [];
                let workingDraft = null;

                if (workingDraftId) {
                    workingDraft = documents.find(d => d?.id === workingDraftId) || null;
                }

                if (!workingDraft) {
                    workingDraft = documents.find(d =>
                        d?.title && d.title.toLowerCase().includes('working draft')
                    ) || null;
                }

                if (workingDraft) {
                    wordCount = workingDraft.wordCount || 0;
                }
            } catch (e) {
                context.warn('Could not fetch word count:', e.message);
            }
            
            // 3. Calculate days to milestone (from calendar/projects)
            let daysToMilestone = 0;
            let milestoneName = 'Confirmation of Candidature';
            try {
                const projectsQuery = 'SELECT * FROM c WHERE c.type = "project_config" OFFSET 0 LIMIT 1';
                const projectResult = await queryItems(CONTAINER_NAME, { query: projectsQuery });
                if (projectResult.length > 0 && projectResult[0].milestoneDate) {
                    const milestoneDate = new Date(projectResult[0].milestoneDate);
                    daysToMilestone = Math.max(0, Math.ceil((milestoneDate - Date.now()) / (1000 * 60 * 60 * 24)));
                    milestoneName = projectResult[0].milestoneName || milestoneName;
                }
            } catch (e) {
                context.warn('Could not fetch milestone:', e.message);
            }
            
            // 4. Count survey responses
            let surveyResponses = 0;
            try {
                const surveysContainer = process.env.COSMOSDB_CONTAINER_SURVEYS || 'surveys';
                const surveyQuery = 'SELECT VALUE COUNT(1) FROM c';
                const surveyResult = await queryItems(surveysContainer, { query: surveyQuery });
                surveyResponses = surveyResult[0] || 0;
            } catch (e) {
                context.warn('Could not fetch survey count:', e.message);
            }
            
            // Get existing snapshot
            let snapshot = await getItem(CONTAINER_NAME, DASHBOARD_SNAPSHOT_ID, DASHBOARD_SNAPSHOT_ID);
            
            if (!snapshot) {
                snapshot = {
                    id: DASHBOARD_SNAPSHOT_ID,
                    history: []
                };
            }
            
            // Add to history before updating
            const now = new Date().toISOString();
            if (snapshot.knowledgeBase !== undefined || snapshot.sourcesForReview !== undefined) {
                const historyEntry = {
                    timestamp: now,
                    knowledgeBase: snapshot.knowledgeBase,
                    sourcesForReview: snapshot.sourcesForReview,
                    wordCount: snapshot.wordCount,
                    surveyResponses: snapshot.surveyResponses
                };
                snapshot.history = [historyEntry, ...(snapshot.history || [])].slice(0, 90);
            }
            
            // Update with fresh values
            snapshot.knowledgeBase = knowledgeBase;
            snapshot.sourcesForReview = sourcesForReview;
            snapshot.wordCount = wordCount;
            snapshot.daysToMilestone = daysToMilestone;
            snapshot.milestoneName = milestoneName;
            snapshot.surveyResponses = surveyResponses;
            snapshot.lastUpdated = now;
            
            await upsertItem(CONTAINER_NAME, snapshot);
            
            context.log(`Dashboard refreshed: KB=${knowledgeBase}, forReview=${sourcesForReview}, words=${wordCount}, surveys=${surveyResponses}`);
            
            // Calculate weekly changes
            const history = snapshot.history || [];

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    knowledgeBase: {
                        current: knowledgeBase,
                        weekChange: getWeekChangeFromHistory(history, 'knowledgeBase', knowledgeBase)
                    },
                    sourcesForReview: {
                        current: sourcesForReview,
                        weekChange: getWeekChangeFromHistory(history, 'sourcesForReview', sourcesForReview)
                    },
                    wordCount: {
                        current: wordCount,
                        weekChange: getWeekChangeFromHistory(history, 'wordCount', wordCount),
                        target: snapshot.wordCountTarget || 80000
                    },
                    daysToMilestone: {
                        current: daysToMilestone,
                        milestoneName: milestoneName
                    },
                    surveyResponses: {
                        current: surveyResponses,
                        weekChange: getWeekChangeFromHistory(history, 'surveyResponses', surveyResponses)
                    },
                    history: history,
                    lastUpdated: now,
                    needsRefresh: false
                })
            };
        } catch (error) {
            context.error('Refresh Dashboard Analytics Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to refresh dashboard analytics', details: error.message })
            };
        }
    }
});

module.exports = { app };
