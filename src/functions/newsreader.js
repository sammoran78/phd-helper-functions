const { app } = require('@azure/functions');
const { queryItems, getItem, upsertItem } = require('../../shared/cosmosClient');
const {
    getResearchSearchPrompt,
    saveResearchSearchPrompt
} = require('../../shared/researchSearchPrompt');
const crypto = require('crypto');

// Shortlist stored in CosmosDB analytics container
const SHORTLIST_CONTAINER = process.env.COSMOSDB_CONTAINER_ANALYTICS || 'analytics';
const REFERENCES_CONTAINER = process.env.COSMOSDB_CONTAINER_REFERENCES || 'references';
const SHORTLIST_ID = 'shortlist';
const SERPAPI_API_KEY = process.env.SERPAPI_API_KEY;
const ANALYTICS_SCOPE = 'all_saved_references';

const normalizeValue = (value) => (value || '').toString().trim().toLowerCase();
const escapeRegExp = (value = '') => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const containsSearchTerm = (text = '', term = '') => {
    const words = term.toString().trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return false;
    const pattern = words.map(escapeRegExp).join('\\s+');
    return new RegExp(`(^|\\W)${pattern}(?=$|\\W)`, 'i').test(text);
};

const normalizeDoi = (value) => {
    const s = normalizeValue(value);
    if (!s) return '';
    return s
        .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
        .replace(/^doi:\s*/i, '')
        .trim();
};

const STOPWORDS = new Set([
    'about', 'above', 'after', 'again', 'against', 'between', 'beyond', 'could', 'should', 'would',
    'these', 'those', 'their', 'there', 'where', 'which', 'while', 'with', 'without', 'using',
    'study', 'studies', 'paper', 'papers', 'research', 'analysis', 'review', 'approach', 'model',
    'system', 'method', 'methods', 'results', 'effect', 'effects', 'based', 'towards', 'future',
    'this', 'that', 'into', 'across', 'within', 'thesis', 'doctoral', 'current', 'framing',
    'examines', 'explores', 'focuses', 'prioritise', 'prioritize', 'quality', 'relevant',
    'internationally', 'empirical', 'theoretical', 'scholarship'
]);

const tokenizeText = (text = '') => text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 3 && !STOPWORDS.has(token));

const pickBestSubject = (gapTokens, subjectTerms) => {
    if (!gapTokens || gapTokens.length === 0) return subjectTerms[0] || '';
    let best = subjectTerms[0] || '';
    let bestScore = 0;
    subjectTerms.forEach(term => {
        const tokens = tokenizeText(term);
        let score = 0;
        tokens.forEach(token => {
            if (gapTokens.includes(token)) score += 1;
        });
        if (score > bestScore) {
            bestScore = score;
            best = term;
        }
    });
    return best;
};

const decodeIdentifier = (value = '') => {
    try {
        return decodeURIComponent(value);
    } catch (error) {
        return value;
    }
};

const getArticleKeys = (article) => {
    const doiKey = normalizeDoi(article?.doi);
    const titleKey = normalizeValue(article?.title);
    return { doiKey, titleKey };
};

const removeFromShortlistByIdentifierKey = async (identifierKey, context) => {
    if (!identifierKey) return;
    let shortlistDoc = await getItem(SHORTLIST_CONTAINER, SHORTLIST_ID, SHORTLIST_ID);
    if (!shortlistDoc || !Array.isArray(shortlistDoc.articles)) return;

    const filtered = shortlistDoc.articles.filter(article => {
        const keys = getArticleKeys(article);
        if (identifierKey && keys.doiKey === identifierKey) return false;
        if (identifierKey && keys.titleKey === identifierKey) return false;
        return true;
    });

    if (filtered.length !== shortlistDoc.articles.length) {
        shortlistDoc.articles = filtered;
        await upsertItem(SHORTLIST_CONTAINER, shortlistDoc);
        context?.log('[Newsreader] Removed item from shortlist');
    }
};

const getIdentifierKeyFromRequest = async (request) => {
    const queryIdentifier = request.query?.get?.('identifier') || request.query?.identifier;
    let bodyIdentifier = null;

    if (!queryIdentifier) {
        try {
            const body = await request.json();
            bodyIdentifier = body?.identifier || body?.doi || body?.title;
        } catch (error) {
            bodyIdentifier = null;
        }
    }

    const rawIdentifier = request.params?.identifier || queryIdentifier || bodyIdentifier;
    if (!rawIdentifier) return null;
    return normalizeValue(decodeIdentifier(rawIdentifier));
};

const buildDismissedId = (doiKey, titleKey) => {
    const base = doiKey || titleKey || 'unknown';
    const hash = crypto.createHash('sha1').update(base).digest('hex');
    return `dismissed_${hash}`;
};

const isDismissedArticle = (article, dismissedDois, dismissedTitles) => {
    const { doiKey, titleKey } = getArticleKeys(article);
    if (doiKey && dismissedDois.has(doiKey)) return true;
    if (titleKey && dismissedTitles.has(titleKey)) return true;
    return false;
};

const extractTag = (entry, tag) => {
    const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const match = entry.match(regex);
    return match ? decodeXml(match[1].trim()) : '';
};

const decodeXml = (value) => (value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

const extractDoiFromUrl = (url = '') => {
    const match = url.match(/doi\.org\/([^?#]+)/i);
    return match ? match[1].trim() : '';
};

const parseYearFromText = (text = '') => {
    const match = text.match(/\b(19|20)\d{2}\b/);
    return match ? parseInt(match[0], 10) : null;
};

const normalizeAuthors = (authorsValue) => {
    if (!authorsValue) return 'Unknown Author';

    if (typeof authorsValue === 'string') {
        const cleaned = authorsValue.trim();
        return cleaned || 'Unknown Author';
    }

    if (Array.isArray(authorsValue)) {
        const list = authorsValue.map(author => {
            if (!author) return '';
            if (typeof author === 'string') return author.trim();
            if (author.name) return author.name.trim();
            if (author.family || author.given) {
                return [author.family, author.given].filter(Boolean).join(', ').trim();
            }
            return '';
        }).filter(Boolean);
        return list.length > 0 ? list.join('; ') : 'Unknown Author';
    }

    if (typeof authorsValue === 'object') {
        if (Array.isArray(authorsValue.authors)) {
            return normalizeAuthors(authorsValue.authors);
        }
        if (authorsValue.name) return authorsValue.name.toString().trim() || 'Unknown Author';
        if (authorsValue.family || authorsValue.given) {
            return [authorsValue.family, authorsValue.given].filter(Boolean).join(', ').trim() || 'Unknown Author';
        }
    }

    return 'Unknown Author';
};

const parseArxivEntries = (xml) => {
    const entries = xml.split('<entry>').slice(1);
    return entries.map(entry => {
        const title = extractTag(entry, 'title').replace(/\s+/g, ' ').trim();
        const summary = extractTag(entry, 'summary').replace(/\s+/g, ' ').trim();
        const published = extractTag(entry, 'published') || extractTag(entry, 'updated');
        const id = extractTag(entry, 'id');
        const doi = extractTag(entry, 'arxiv:doi');
        const authors = Array.from(entry.matchAll(/<name>([^<]+)<\/name>/gi))
            .map(match => decodeXml(match[1].trim()))
            .join('; ');
        return {
            title,
            summary,
            published,
            id,
            doi,
            authors
        };
    }).filter(entry => entry.title);
};

const loadDismissedSets = async (context) => {
    try {
        const dismissedItems = await queryItems(REFERENCES_CONTAINER, {
            query: 'SELECT c.id, c.title, c.doi, c.titleKey, c.doiKey FROM c WHERE c.dismissed = true'
        });
        const dismissedDois = new Set();
        const dismissedTitles = new Set();
        const dismissedTokenSets = [];
        const dismissedTokenCounts = new Map();

        dismissedItems.forEach(item => {
            const doiKey = normalizeDoi(item.doiKey || item.doi);
            const titleKey = normalizeValue(item.titleKey || item.title);
            if (doiKey) dismissedDois.add(doiKey);
            if (titleKey) dismissedTitles.add(titleKey);

            const tokens = tokenizeText(item.title || '');
            if (tokens.length > 0) {
                dismissedTokenSets.push(new Set(tokens));
                tokens.forEach(token => {
                    dismissedTokenCounts.set(token, (dismissedTokenCounts.get(token) || 0) + 1);
                });
            }
        });

        return {
            dismissedDois,
            dismissedTitles,
            dismissedTokenSets,
            dismissedTokenCounts: Array.from(dismissedTokenCounts.entries())
        };
    } catch (error) {
        context?.warn('[Newsreader] Failed to load dismissed items:', error.message);
        return {
            dismissedDois: new Set(),
            dismissedTitles: new Set(),
            dismissedTokenSets: [],
            dismissedTokenCounts: []
        };
    }
};

const removeFromShortlistByKeys = async (doiKey, titleKey, context) => {
    if (!doiKey && !titleKey) return;
    const shortlistDoc = await getItem(SHORTLIST_CONTAINER, SHORTLIST_ID, SHORTLIST_ID);
    if (!shortlistDoc || !Array.isArray(shortlistDoc.articles)) return;

    const filtered = shortlistDoc.articles.filter(article => {
        const articleKeys = getArticleKeys(article);
        if (doiKey && articleKeys.doiKey === doiKey) return false;
        if (titleKey && articleKeys.titleKey === titleKey) return false;
        return true;
    });

    if (filtered.length !== shortlistDoc.articles.length) {
        shortlistDoc.articles = filtered;
        await upsertItem(SHORTLIST_CONTAINER, shortlistDoc);
        context?.log('[Newsreader] Removed dismissed item from shortlist');
    }
};

const handleDismissRequest = async (body, context) => {
    const { doi, title, url, source, authors, year } = body || {};
    if (!doi && !title) {
        return {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'doi or title required' })
        };
    }

    const doiKey = normalizeDoi(doi || extractDoiFromUrl(url || ''));
    const titleKey = normalizeValue(title);
    const dismissedId = buildDismissedId(doiKey, titleKey);

    const dismissedDoc = {
        id: dismissedId,
        type: 'dismissed',
        dismissed: true,
        doi: doi || null,
        title: title || null,
        url: url || null,
        source: source || null,
        authors: authors || null,
        year: year || null,
        doiKey: doiKey || null,
        titleKey: titleKey || null,
        dateDismissed: new Date().toISOString()
    };

    await upsertItem(REFERENCES_CONTAINER, dismissedDoc);
    await removeFromShortlistByKeys(doiKey, titleKey, context);

    return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true })
    };
};

// GET /api/newsreader/search-prompt - Get the shared thesis framing for discovery and gaps
app.http('GetResearchSearchPrompt', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'newsreader/search-prompt',
    handler: async (request, context) => {
        try {
            const prompt = await getResearchSearchPrompt();
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(prompt)
            };
        } catch (error) {
            context.error('Get Research Search Prompt Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to load research search prompt', details: error.message })
            };
        }
    }
});

// PUT /api/newsreader/search-prompt - Persist the shared thesis framing
app.http('UpdateResearchSearchPrompt', {
    methods: ['PUT'],
    authLevel: 'anonymous',
    route: 'newsreader/search-prompt',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const saved = await saveResearchSearchPrompt(body?.content ?? body?.prompt);
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(saved)
            };
        } catch (error) {
            const status = error?.status === 400 ? 400 : 500;
            if (status === 500) context.error('Update Research Search Prompt Error:', error);
            return {
                status,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    error: status === 400 ? error.message : 'Failed to update research search prompt',
                    ...(status === 500 ? { details: error.message } : {})
                })
            };
        }
    }
});

// GET /api/newsreader/shortlist - Get shortlisted articles
app.http('GetShortlist', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'newsreader/shortlist',
    handler: async (request, context) => {
        try {
            const querySpec = {
                query: 'SELECT * FROM c WHERE c.type = "shortlist"'
            };
            const items = await queryItems(SHORTLIST_CONTAINER, querySpec);
            let shortlist = items.length > 0 ? (items[0].articles || []) : [];

            const { dismissedDois, dismissedTitles } = await loadDismissedSets(context);
            shortlist = shortlist.filter(article => !isDismissedArticle(article, dismissedDois, dismissedTitles));

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(shortlist)
            };
        } catch (error) {
            context.error('Get Shortlist Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to load shortlist', details: error.message })
            };
        }
    }
});

// DELETE /api/newsreader/shortlist?identifier=... - Remove from shortlist (query/body)
app.http('RemoveFromShortlistByQuery', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'newsreader/shortlist',
    handler: async (request, context) => {
        try {
            const identifierKey = await getIdentifierKeyFromRequest(request);
            if (!identifierKey) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'identifier required' })
                };
            }

            await removeFromShortlistByIdentifierKey(identifierKey, context);

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true })
            };
        } catch (error) {
            context.error('Remove from Shortlist Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to remove from shortlist', details: error.message })
            };
        }
    }
});

// POST /api/newsreader/shortlist - Add article to shortlist
app.http('AddToShortlist', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'newsreader/shortlist',
    handler: async (request, context) => {
        try {
            const article = await request.json();
            if (!article.title) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Article title required' })
                };
            }

            const { doiKey, titleKey } = getArticleKeys(article);
            const { dismissedDois, dismissedTitles } = await loadDismissedSets(context);
            if (isDismissedArticle(article, dismissedDois, dismissedTitles)) {
                return {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ success: true, skipped: true })
                };
            }

            let shortlistDoc = await getItem(SHORTLIST_CONTAINER, SHORTLIST_ID, SHORTLIST_ID);
            if (!shortlistDoc) {
                shortlistDoc = { id: SHORTLIST_ID, type: 'shortlist', articles: [] };
            }

            const exists = shortlistDoc.articles.some(a => {
                const keys = getArticleKeys(a);
                return (doiKey && keys.doiKey === doiKey) || (titleKey && keys.titleKey === titleKey);
            });

            if (!exists) {
                shortlistDoc.articles.push({
                    ...article,
                    doiKey: doiKey || null,
                    titleKey: titleKey || null,
                    addedAt: new Date().toISOString()
                });
                await upsertItem(SHORTLIST_CONTAINER, shortlistDoc);
            }

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true })
            };
        } catch (error) {
            context.error('Add to Shortlist Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to add to shortlist', details: error.message })
            };
        }
    }
});

// DELETE /api/newsreader/shortlist/{identifier} - Remove from shortlist
app.http('RemoveFromShortlist', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'newsreader/shortlist/{identifier}',
    handler: async (request, context) => {
        try {
            const identifierKey = await getIdentifierKeyFromRequest(request);
            if (!identifierKey) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'identifier required' })
                };
            }

            await removeFromShortlistByIdentifierKey(identifierKey, context);

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true })
            };
        } catch (error) {
            context.error('Remove from Shortlist Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to remove from shortlist', details: error.message })
            };
        }
    }
});

// POST /api/newsreader/dismiss - Mark an article as dismissed
app.http('DismissNewsreaderArticle', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'newsreader/dismiss',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            return await handleDismissRequest(body, context);
        } catch (error) {
            context.error('Dismiss Article Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to dismiss article', details: error.message })
            };
        }
    }
});

// GET /api/newsreader/articles - Fetch daily research articles
app.http('GetNewsreaderArticles', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'newsreader/articles',
    handler: async (request, context) => {
        try {
            context.log('[Newsreader] Fetching daily articles...');
            const filterNew = request.query.get('filter') === 'new';
            
            // Load existing references from CosmosDB
            let existingRefs = [];
            try {
                const querySpec = { query: 'SELECT c.title, c.doi, c.url FROM c' };
                existingRefs = await queryItems(REFERENCES_CONTAINER, querySpec);
            } catch (e) { context.warn('[Newsreader] Could not load references:', e.message); }
            
            // Load shortlist
            let shortlist = [];
            try {
                const { getItem } = require('../../shared/cosmosClient');
                const shortlistDoc = await getItem(SHORTLIST_CONTAINER, 'shortlist', 'shortlist');
                shortlist = shortlistDoc?.articles || [];
            } catch (e) { context.warn('[Newsreader] Could not load shortlist:', e.message); }
            
            // Build sets for filtering
            const { dismissedDois, dismissedTitles, dismissedTokenSets, dismissedTokenCounts } = await loadDismissedSets(context);
            const existingDOIs = new Set([
                ...existingRefs
                    .map(r => r.url)
                    .filter(u => u && (/doi\.org\//i.test(u) || /^doi:\s*/i.test(u))),
                ...existingRefs.map(r => r.doi).filter(Boolean),
                ...shortlist.map(s => s.doi).filter(Boolean)
            ].map(normalizeDoi).filter(Boolean));
            const existingTitles = new Set([
                ...existingRefs.map(r => r.title ? r.title.toLowerCase().trim() : ''),
                ...shortlist.map(s => s.title ? s.title.toLowerCase().trim() : '')
            ].map(normalizeValue).filter(Boolean));
            
            const AI_RELEVANCE_KEYWORDS = [
                'artificial intelligence', 'AI', 'machine learning', 'generative', 'neural network',
                'deep learning', 'GPT', 'LLM', 'language model', 'diffusion', 'DALL-E', 'Midjourney',
                'ChatGPT', 'automation', 'algorithmic',
                'generative ai', 'genai', 'gen-ai'
            ];

            const THESIS_SCOPE_KEYWORDS = [
                'creative labor', 'creative labour', 'labor', 'labour', 'work', 'worker', 'employment',
                'creative industries', 'cultural industries', 'cultural production',
                'arts', 'creative arts', 'art', 'artist', 'artists',
                'media', 'communication', 'journalism', 'content',
                'design', 'designer', 'music', 'writing', 'author', 'authors', 'authorship',
                'copyright', 'intellectual property', 'licensing', 'attribution',
                'platform', 'gig economy', 'creator economy',
                'co-creation', 'collaboration', 'agency', 'precarity', 'deskilling'
            ];

            const THESIS_SCOPE_TOKEN_SET = new Set(tokenizeText(THESIS_SCOPE_KEYWORDS.join(' ')));
            const isThesisScopedTerm = (term = '') => {
                const tokens = tokenizeText(term);
                return tokens.some(t => THESIS_SCOPE_TOKEN_SET.has(t));
            };

            const dismissedNegativeTokenSet = new Set(
                Array.isArray(dismissedTokenCounts)
                    ? dismissedTokenCounts
                        .filter(([token, count]) => token && count >= 2 && !THESIS_SCOPE_TOKEN_SET.has(token))
                        .sort((a, b) => (b?.[1] || 0) - (a?.[1] || 0))
                        .slice(0, 25)
                        .map(([token]) => token)
                    : []
            );

            const researchPromptDocument = await getResearchSearchPrompt();
            const researchPrompt = researchPromptDocument.content;
            const researchPromptTokens = Array.from(new Set(tokenizeText(researchPrompt))).slice(0, 32);
            const researchPromptTokenSet = new Set(researchPromptTokens);
            const researchPromptQueries = researchPrompt
                .split(/(?<=[.!?])\s+/)
                .map(sentence => Array.from(new Set(tokenizeText(sentence))).slice(0, 16).join(' '))
                .filter(query => query.split(' ').length >= 3)
                .slice(0, 2)
                .map(query => ({ query, category: 'Thesis Focus' }));
            const REQUIRED_QUERY_ANCHOR = researchPromptTokens.slice(0, 12).join(' ') || 'creative labor creative industries arts media communication';
            const anchorQuery = (query = '') => `${query} ${REQUIRED_QUERY_ANCHOR}`.replace(/\s+/g, ' ').trim();

            const RQ_SEARCH_QUERIES = [
                { query: 'creative agency generative AI creative workers lived experience interviews ethnography', category: 'RQ1: Creative Agency' },
                { query: 'co-creation tactics steering constraining prompts authorship credit client transparency generative AI', category: 'RQ2a: Co-Creation Tactics' },
                { query: 'validation transferability AI creative tactics across music screen design interactive career stages', category: 'RQ2b: Transferability' },
                { query: 'teaching resources industry guidance policy recommendations sustainable creative practice generative AI', category: 'RQ3: Translation to Practice' },
                { query: 'attribution metadata provenance royalty licensing consent compensation creators generative AI systems', category: 'Attribution & Royalties' }
            ];
            
            // Search queries
            const baseSearchQueries = [
                { query: 'longitudinal study generative AI creative practice workflow', category: 'Longitudinal AI Studies' },
                { query: 'ethnography AI creative work studio practice', category: 'AI Ethnography' },
                { query: 'AI governance creative industries provenance attribution', category: 'AI Governance' },
                { query: 'AI copyright licensing consent compensation creators', category: 'Copyright & Licensing' },
                { query: 'AI embodied creativity performance craft making', category: 'Embodied AI Creativity' },
                { query: 'AI creative industries global south non-western', category: 'Global Perspectives' },
                { query: 'AI sustainability compute carbon creative production', category: 'AI Sustainability' },
                { query: 'generative AI creative labor automation displacement', category: 'Creative AI & Labor' },
                { query: 'human AI co-creation collaboration creativity HCI', category: 'Human-AI Co-Creativity' },
                { query: 'AI copyright intellectual property training data artists', category: 'Copyright & IP' },
                { query: 'AI creative industries cultural production work', category: 'Creative Industries' },
                { query: 'large language models writing authorship text generation', category: 'LLMs & Writing' },
                { query: 'AI art visual design image generation artists', category: 'AI Art & Design' },
                { query: 'AI music composition production audio generation', category: 'AI & Music' },
                { query: 'AI agency autonomy creativity intentionality', category: 'AI & Agency' }
            ];

            // Fetch latest analytics to get research gaps
            let analyticsGaps = [];
            let analyticsSubjects = [];
            let analyticsDomains = [];
            try {
                const querySpec = {
                    query: 'SELECT * FROM c WHERE c.type = "corpus_analysis" AND c.scope = @scope ORDER BY c.dateGenerated DESC OFFSET 0 LIMIT 1',
                    parameters: [{ name: '@scope', value: ANALYTICS_SCOPE }]
                };
                const analyticsResults = await queryItems(SHORTLIST_CONTAINER, querySpec);
                const latest = analyticsResults[0];
                const analyticsMatchesPrompt = latest?.researchPromptUpdatedAt === researchPromptDocument.updatedAt;
                if (latest && analyticsMatchesPrompt) {
                    analyticsGaps = Array.isArray(latest.gaps) ? latest.gaps : [];
                    analyticsSubjects = Array.isArray(latest.subjects)
                        ? latest.subjects.map(s => s?.name).filter(Boolean)
                        : [];

                    const domainNames = new Set();
                    analyticsGaps.forEach(gap => {
                        const domains = gap?.connectedDomains || gap?.suggestedDomains || [];
                        if (Array.isArray(domains)) {
                            domains.forEach(d => {
                                if (d) domainNames.add(d);
                            });
                        }
                    });
                    analyticsDomains = Array.from(domainNames);

                    context.log(`[Newsreader] Loaded analytics: ${analyticsGaps.length} gaps, ${analyticsSubjects.length} subjects`);
                } else if (latest) {
                    context.log('[Newsreader] Saved gap analysis predates the current research search prompt; using prompt-led discovery until Analytics is refreshed.');
                }
            } catch (e) {
                context.warn('[Newsreader] Failed to load analytics gaps:', e.message);
            }

            // Generate gap-based queries
            const gapQueries = [];
            analyticsGaps.forEach(gap => {
                const baseQueries = Array.isArray(gap?.searchQueries) && gap.searchQueries.length > 0
                    ? gap.searchQueries.slice(0, 2)
                    : [`${gap?.name || ''} ${gap?.description || ''}`.trim()];

                const gapTokens = tokenizeText(`${gap?.name || ''} ${gap?.description || ''}`);
                const bestSubject = pickBestSubject(gapTokens, analyticsSubjects.slice(0, 10));
                const domainTokens = tokenizeText((gap?.connectedDomains || gap?.suggestedDomains || []).join(' ')).slice(0, 4);
                const domainSuffix = domainTokens.length > 0 ? domainTokens.join(' ') : '';

                baseQueries.forEach(q => {
                    const combined = anchorQuery(`${q} ${domainSuffix} ${bestSubject}`.replace(/\s+/g, ' ').trim());
                    if (!combined) return;
                    gapQueries.push({
                        query: combined,
                        category: `Gap: ${gap?.name || 'Research Gap'}`
                    });
                });
            });

            // Generate subject/topic queries from your existing corpus topics
            const subjectQueries = analyticsSubjects
                .filter(term => term && term.length > 3)
                .filter(term => isThesisScopedTerm(term))
                .slice(0, 6)
                .map(term => ({
                    query: anchorQuery(`"${term}" generative AI creativity creative industries`),
                    category: `Topic: ${term}`
                }));

            // Generate domain queries from connected research areas
            const domainQueries = analyticsDomains
                .filter(domain => domain && domain.length > 2)
                .filter(domain => isThesisScopedTerm(domain))
                .slice(0, 5)
                .map(domain => ({
                    query: anchorQuery(`${domain} generative AI creative labor`),
                    category: `Domain: ${domain}`
                }));

            // Prioritize the editable thesis framing, then RQs, current gaps and corpus topics.
            const searchQueries = [
                ...researchPromptQueries,
                ...RQ_SEARCH_QUERIES.map(q => ({ ...q, query: anchorQuery(q.query) })),
                ...gapQueries,
                ...subjectQueries,
                ...domainQueries,
                ...baseSearchQueries.map(q => ({ ...q, query: anchorQuery(q.query) }))
            ].filter((entry, idx, arr) => {
                const normalized = normalizeValue(entry?.query);
                return arr.findIndex(x => normalizeValue(x?.query) === normalized) === idx;
            });

            const scoreArticleRelevance = (title, abstract) => {
                const titleText = (title || '').toLowerCase();
                const abstractText = (abstract || '').toLowerCase();
                const fullText = `${titleText} ${abstractText}`;

                let score = 0;

                const aiTitleHit = AI_RELEVANCE_KEYWORDS.some(kw => containsSearchTerm(titleText, kw));
                const aiAbstractHit = AI_RELEVANCE_KEYWORDS.some(kw => containsSearchTerm(abstractText, kw));
                const scopeTitleHit = THESIS_SCOPE_KEYWORDS.some(kw => containsSearchTerm(titleText, kw));
                const scopeAbstractHit = THESIS_SCOPE_KEYWORDS.some(kw => containsSearchTerm(abstractText, kw));

                if (aiTitleHit) score += 4;
                else if (aiAbstractHit) score += 2;

                if (scopeTitleHit) score += 4;
                else if (scopeAbstractHit) score += 2;

                const focusGroups = [
                    ['creative agency', 'agency', 'autonomy', 'creative worker', 'co-creation'],
                    ['workflow', 'tactic', 'strategy', 'authorship', 'credit', 'client transparency', 'steering', 'constraining'],
                    ['validation', 'transferable', 'transferability', 'music', 'screen', 'design', 'interactive', 'career stage'],
                    ['teaching', 'curriculum', 'industry guidance', 'policy', 'sustainable practice'],
                    ['attribution', 'metadata', 'provenance', 'royalty', 'licensing', 'consent', 'compensation']
                ];

                focusGroups.forEach(group => {
                    const titleHit = group.some(term => containsSearchTerm(titleText, term));
                    const fullHit = group.some(term => containsSearchTerm(fullText, term));
                    if (titleHit) score += 3;
                    else if (fullHit) score += 1;
                });

                const titlePromptMatches = new Set(tokenizeText(titleText).filter(token => researchPromptTokenSet.has(token))).size;
                const abstractPromptMatches = new Set(tokenizeText(abstractText).filter(token => researchPromptTokenSet.has(token))).size;
                score += Math.min(10, titlePromptMatches * 2);
                score += Math.min(5, abstractPromptMatches);

                return score;
            };

            const scoreArticleImpact = (citationCount, source, abstract) => {
                const citations = Math.max(0, Number(citationCount) || 0);
                let score = Math.min(6, Math.log10(citations + 1) * 2.5);
                if ((source || '').trim()) score += 0.5;
                if ((abstract || '').trim().length >= 200) score += 0.5;
                return Number(score.toFixed(2));
            };
            
            const isRelevantArticle = (title, abstract) => {
                const text = `${title || ''} ${abstract || ''}`.toLowerCase();
                const promptMatchCount = new Set(tokenizeText(text).filter(token => researchPromptTokenSet.has(token))).size;
                const hasAiKeyword = AI_RELEVANCE_KEYWORDS.some(kw => containsSearchTerm(text, kw));
                if (!hasAiKeyword && promptMatchCount < 2) return false;

                const hasScopeKeyword = THESIS_SCOPE_KEYWORDS.some(kw => containsSearchTerm(text, kw));
                if (!hasScopeKeyword && promptMatchCount < 3) return false;

                if (dismissedNegativeTokenSet && dismissedNegativeTokenSet.size > 0) {
                    const tokens = tokenizeText(`${title || ''} ${abstract || ''}`);
                    const negativeMatches = tokens.filter(t => dismissedNegativeTokenSet.has(t));
                    const uniqueNegativeMatches = new Set(negativeMatches);
                    if (uniqueNegativeMatches.size >= 3) return false;
                }
                
                const offTopicPatterns = [
                    /\bhealthcare\b/i, /\bmedical\b/i, /\bclinical\b/i, /\bpatient\b/i,
                    /\bbiological\b/i, /\bchemistry\b/i, /\bphysics\b/i, /\bgeology\b/i,
                    /\bquantum\b/i, /\bcosmology\b/i, /\bastronomy\b/i, /\bsatellite\b/i, /\blunar\b/i,
                    /\bagriculture\b/i, /\bfarming\b/i, /\bcrop\b/i,
                    /\bsports\b/i, /\bathletic\b/i,
                    /\bfinancial\b/i, /\bbanking\b/i, /\bstock\b/i,
                    /\bmilitary\b/i, /\bdefense\b/i, /\bweapon\b/i
                ];
                if (offTopicPatterns.some(pattern => pattern.test(text))) return false;

                const relevanceScore = scoreArticleRelevance(title, abstract);
                return relevanceScore >= 6;
            };
            
            const allArticles = [];
            const now = new Date();
            const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
            const sixMonthsAgo = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
            const twelveYearsAgo = new Date(now.getTime() - 12 * 365 * 24 * 60 * 60 * 1000);
            const minYear = filterNew ? now.getFullYear() - 1 : now.getFullYear() - 12;
            
            const fromDate = filterNew 
                ? sixMonthsAgo.toISOString().split('T')[0]
                : twelveYearsAgo.toISOString().split('T')[0];
            
            const isTooSimilarToDismissed = (title) => {
                if (!title || dismissedTokenSets.length === 0) return false;
                const titleTokens = tokenizeText(title);
                if (titleTokens.length === 0) return false;

                return dismissedTokenSets.some(tokensSet => {
                    const requiredMatches = Math.min(3, Math.max(2, Math.ceil(tokensSet.size * 0.6)));
                    let matches = 0;
                    titleTokens.forEach(token => {
                        if (tokensSet.has(token)) matches += 1;
                    });
                    return matches >= requiredMatches;
                });
            };

            const isValidArticle = (title, doi, abstract = '') => {
                if (!title || title.length < 10) return false;
                if (/^[\d\.\s]+$/.test(title)) return false;
                if (/^title pending/i.test(title)) return false;
                const titleLower = normalizeValue(title);
                const doiKey = normalizeDoi(doi);
                if (doiKey && existingDOIs.has(doiKey)) return false;
                if (titleLower && existingTitles.has(titleLower)) return false;
                if (doiKey && dismissedDois.has(doiKey)) return false;
                if (titleLower && dismissedTitles.has(titleLower)) return false;
                if (isTooSimilarToDismissed(title)) return false;
                if (allArticles.some(a => {
                    const keys = getArticleKeys(a);
                    return (doiKey && keys.doiKey === doiKey) || (titleLower && keys.titleKey === titleLower);
                })) return false;
                if (!isRelevantArticle(title, abstract)) return false;
                return true;
            };
            
            const parseYear = (item) => {
                const dateParts = item.published?.['date-parts']?.[0] 
                    || item['published-print']?.['date-parts']?.[0] 
                    || item['published-online']?.['date-parts']?.[0]
                    || item.created?.['date-parts']?.[0];
                if (dateParts && dateParts[0] >= 1900 && dateParts[0] <= now.getFullYear() + 1) {
                    return dateParts[0];
                }
                return null;
            };
            
            const getPublishedDate = (item) => {
                const dateParts = item.published?.['date-parts']?.[0] 
                    || item['published-print']?.['date-parts']?.[0] 
                    || item['published-online']?.['date-parts']?.[0];
                if (dateParts) {
                    const [year, month = 1, day = 1] = dateParts;
                    return new Date(year, month - 1, day);
                }
                return null;
            };
            
            // Search CrossRef
            for (const sq of searchQueries.slice(0, 8)) {
                try {
                    const crossrefUrl = `https://api.crossref.org/works?query=${encodeURIComponent(sq.query)}&rows=10&sort=published&order=desc&filter=type:journal-article,type:proceedings-article,from-pub-date:${fromDate}`;
                    const response = await fetch(crossrefUrl, { 
                        headers: { 'User-Agent': 'PhD-Helper/1.0 (mailto:research@example.com)' }
                    });
                    if (!response.ok) continue;
                    const data = await response.json();
                    if (!data.message?.items) continue;
                    
                    for (const item of data.message.items) {
                        const doi = item.DOI;
                        const title = item.title?.[0];
                        const abstract = item.abstract?.replace(/<[^>]*>/g, '') || '';
                        if (!isValidArticle(title, doi, abstract)) continue;
                        
                        const year = parseYear(item);
                        if (!year || year < minYear || year > now.getFullYear() + 1) continue;
                        
                        const pubDate = getPublishedDate(item);
                        const isNew = pubDate && pubDate >= ninetyDaysAgo;
                        
                        let authors = '';
                        if (item.author?.length > 0) {
                            authors = item.author
                                .filter(a => a.family || a.name)
                                .map(a => a.family && a.given ? `${a.family}, ${a.given}` : a.family || a.name)
                                .join('; ');
                        }
                        
                        const source = item['container-title']?.[0] || item.publisher || '';
                        const citationCount = Number(item['is-referenced-by-count'] || 0);
                        const typeMap = { 'journal-article': 'Journal Article', 'book-chapter': 'Book Section', 'proceedings-article': 'Conference Paper' };
                        
                        allArticles.push({
                            doi,
                            title,
                            authors: normalizeAuthors(authors),
                            year: String(year),
                            source,
                            type: typeMap[item.type] || 'Article',
                            abstract: item.abstract?.replace(/<[^>]*>/g, '').substring(0, 1000) || '',
                            url: item.URL || (doi ? `https://doi.org/${doi}` : ''),
                            category: sq.category,
                            isNew,
                            publishedDate: pubDate?.toISOString(),
                            relevanceScore: scoreArticleRelevance(title, abstract),
                            citationCount,
                            impactScore: scoreArticleImpact(citationCount, source, abstract),
                            apiSource: 'CrossRef',
                            doiKey: normalizeDoi(doi),
                            titleKey: normalizeValue(title)
                        });
                    }
                } catch (e) { context.warn('[Newsreader] CrossRef query failed:', sq.query, e.message); }
            }
            
            // Search Semantic Scholar
            for (const sq of searchQueries.slice(0, 4)) {
                try {
                    const ssUrl = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(sq.query)}&limit=8&fields=title,authors,year,abstract,url,venue,publicationDate,externalIds,citationCount,influentialCitationCount`;
                    const response = await fetch(ssUrl, { 
                        headers: { 'User-Agent': 'PhD-Helper/1.0' }
                    });
                    if (!response.ok) continue;
                    const data = await response.json();
                    if (!data.data) continue;
                    
                    for (const paper of data.data) {
                        const doi = paper.externalIds?.DOI;
                        const title = paper.title;
                        const paperAbstract = paper.abstract || '';
                        if (!isValidArticle(title, doi || paper.paperId, paperAbstract)) continue;
                        
                        const year = paper.year;
                        if (!year || year < minYear || year > now.getFullYear() + 1) continue;
                        
                        const pubDate = paper.publicationDate ? new Date(paper.publicationDate) : null;
                        const isNew = pubDate && pubDate >= ninetyDaysAgo;
                        
                        const authors = paper.authors?.map(a => a.name).join('; ') || 'Unknown Author';
                        const citationCount = Number(paper.citationCount || 0);
                        
                        allArticles.push({
                            doi: doi || paper.paperId,
                            title,
                            authors: normalizeAuthors(authors),
                            year: String(year),
                            source: paper.venue || 'Semantic Scholar',
                            type: 'Article',
                            abstract: paper.abstract?.substring(0, 1000) || '',
                            url: paper.url || (doi ? `https://doi.org/${doi}` : `https://www.semanticscholar.org/paper/${paper.paperId}`),
                            category: sq.category,
                            isNew,
                            publishedDate: pubDate?.toISOString(),
                            relevanceScore: scoreArticleRelevance(title, paperAbstract),
                            citationCount,
                            influentialCitationCount: Number(paper.influentialCitationCount || 0),
                            impactScore: scoreArticleImpact(citationCount, paper.venue, paperAbstract),
                            apiSource: 'Semantic Scholar',
                            doiKey: normalizeDoi(doi || paper.paperId),
                            titleKey: normalizeValue(title)
                        });
                    }
                } catch (e) { context.warn('[Newsreader] Semantic Scholar query failed:', sq.query, e.message); }
            }

            // Search Google Scholar via SerpAPI (optional)
            if (SERPAPI_API_KEY) {
                for (const sq of searchQueries.slice(0, 3)) {
                    try {
                        const serpUrl = `https://serpapi.com/search.json?engine=google_scholar&q=${encodeURIComponent(sq.query)}&api_key=${SERPAPI_API_KEY}`;
                        const response = await fetch(serpUrl, { headers: { 'User-Agent': 'PhD-Helper/1.0' } });
                        if (!response.ok) continue;
                        const data = await response.json();
                        const results = Array.isArray(data.organic_results) ? data.organic_results : [];

                        for (const item of results) {
                            const title = item.title;
                            const link = item.link || '';
                            const doi = extractDoiFromUrl(link) || '';
                            const abstract = item.snippet || '';
                            if (!isValidArticle(title, doi || title, abstract)) continue;

                            const summaryText = item.publication_info?.summary || item.publication_info?.authors || '';
                            const year = parseYearFromText(summaryText) || parseYearFromText(abstract);
                            if (!year || year < minYear || year > now.getFullYear() + 1) continue;

                            const googleAuthors = normalizeAuthors(item.publication_info?.authors || item.publication_info?.summary || '');
                            const citationCount = Number(item.inline_links?.cited_by?.total || 0);

                            allArticles.push({
                                doi: doi || link,
                                title,
                                authors: googleAuthors,
                                year: String(year),
                                source: 'Google Scholar',
                                type: 'Article',
                                abstract: abstract.substring(0, 1000),
                                url: link,
                                category: sq.category,
                                isNew: year >= now.getFullYear() - 1,
                                publishedDate: null,
                                relevanceScore: scoreArticleRelevance(title, abstract),
                                citationCount,
                                impactScore: scoreArticleImpact(citationCount, 'Google Scholar', abstract),
                                apiSource: 'Google Scholar (SerpAPI)',
                                doiKey: normalizeDoi(doi || link),
                                titleKey: normalizeValue(title)
                            });
                        }
                    } catch (e) { context.warn('[Newsreader] SerpAPI query failed:', sq.query, e.message); }
                }
            } else {
                context.warn('[Newsreader] SERPAPI_API_KEY not set; skipping Google Scholar search.');
            }

            // Search arXiv (broader preprint coverage)
            for (const sq of searchQueries.slice(0, 6)) {
                try {
                    const arxivQuery = encodeURIComponent(`${sq.query} AND submittedDate:[${fromDate.replace(/-/g, '')}0000 TO ${now.toISOString().slice(0,10).replace(/-/g, '')}2359]`);
                    const arxivUrl = `https://export.arxiv.org/api/query?search_query=all:${arxivQuery}&start=0&max_results=8&sortBy=submittedDate&sortOrder=descending`;
                    const response = await fetch(arxivUrl, { headers: { 'User-Agent': 'PhD-Helper/1.0' } });
                    if (!response.ok) continue;
                    const xml = await response.text();
                    const entries = parseArxivEntries(xml);

                    for (const entry of entries) {
                        const title = entry.title;
                        const doi = entry.doi || entry.id;
                        const abstract = entry.summary || '';
                        if (!isValidArticle(title, doi, abstract)) continue;

                        const publishedDate = entry.published ? new Date(entry.published) : null;
                        const year = publishedDate ? publishedDate.getFullYear() : null;
                        if (!year || year < minYear || year > now.getFullYear() + 1) continue;

                        const isNew = publishedDate && publishedDate >= ninetyDaysAgo;

                        allArticles.push({
                            doi: entry.doi || entry.id,
                            title,
                            authors: normalizeAuthors(entry.authors),
                            year: String(year),
                            source: 'arXiv',
                            type: 'Preprint',
                            abstract: abstract.substring(0, 1000),
                            url: entry.id || (entry.doi ? `https://doi.org/${entry.doi}` : ''),
                            category: sq.category,
                            isNew,
                            publishedDate: publishedDate?.toISOString(),
                            relevanceScore: scoreArticleRelevance(title, abstract),
                            citationCount: 0,
                            impactScore: scoreArticleImpact(0, 'arXiv', abstract),
                            apiSource: 'arXiv',
                            doiKey: normalizeDoi(entry.doi || entry.id),
                            titleKey: normalizeValue(title)
                        });
                    }
                } catch (e) { context.warn('[Newsreader] arXiv query failed:', sq.query, e.message); }
            }
            
            // Sort by relevance first, then recency
            let results = allArticles.sort((a, b) => {
                const rankingDiff = ((b.relevanceScore || 0) + (b.impactScore || 0))
                    - ((a.relevanceScore || 0) + (a.impactScore || 0));
                if (rankingDiff !== 0) return rankingDiff;
                const dateA = a.publishedDate ? new Date(a.publishedDate) : new Date(a.year, 0, 1);
                const dateB = b.publishedDate ? new Date(b.publishedDate) : new Date(b.year, 0, 1);
                return dateB - dateA;
            });
            
            if (filterNew) {
                results = results.filter(a => a.isNew);
            }
            
            const filteredResults = results.filter(article => !isDismissedArticle(article, dismissedDois, dismissedTitles));
            context.log(`[Newsreader] Found ${filteredResults.length} articles (filter: ${filterNew ? 'new' : 'all'})`);
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(filteredResults.slice(0, 30))
            };
        } catch (error) {
            context.error('[Newsreader] Articles error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to fetch articles', details: error.message })
            };
        }
    }
});
