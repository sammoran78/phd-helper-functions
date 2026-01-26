const { app } = require('@azure/functions');
const { queryItems, getItem, upsertItem } = require('../../shared/cosmosClient');
const crypto = require('crypto');

// Shortlist stored in CosmosDB analytics container
const SHORTLIST_CONTAINER = process.env.COSMOSDB_CONTAINER_ANALYTICS || 'analytics';
const REFERENCES_CONTAINER = process.env.COSMOSDB_CONTAINER_REFERENCES || 'references';
const SHORTLIST_ID = 'shortlist';
const SERPAPI_API_KEY = process.env.SERPAPI_API_KEY;

const normalizeValue = (value) => (value || '').toString().trim().toLowerCase();

const STOPWORDS = new Set([
    'about', 'above', 'after', 'again', 'against', 'between', 'beyond', 'could', 'should', 'would',
    'these', 'those', 'their', 'there', 'where', 'which', 'while', 'with', 'without', 'using',
    'study', 'studies', 'paper', 'papers', 'research', 'analysis', 'review', 'approach', 'model',
    'system', 'method', 'methods', 'results', 'effect', 'effects', 'based', 'towards', 'future'
]);

const tokenizeText = (text = '') => text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 3 && !STOPWORDS.has(token));

const decodeIdentifier = (value = '') => {
    try {
        return decodeURIComponent(value);
    } catch (error) {
        return value;
    }
};

const getArticleKeys = (article) => {
    const doiKey = normalizeValue(article?.doi);
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

        dismissedItems.forEach(item => {
            const doiKey = normalizeValue(item.doiKey || item.doi);
            const titleKey = normalizeValue(item.titleKey || item.title);
            if (doiKey) dismissedDois.add(doiKey);
            if (titleKey) dismissedTitles.add(titleKey);

            const tokens = tokenizeText(item.title || '');
            if (tokens.length > 0) {
                dismissedTokenSets.push(new Set(tokens));
            }
        });

        return { dismissedDois, dismissedTitles, dismissedTokenSets };
    } catch (error) {
        context?.warn('[Newsreader] Failed to load dismissed items:', error.message);
        return { dismissedDois: new Set(), dismissedTitles: new Set(), dismissedTokenSets: [] };
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

    const doiKey = normalizeValue(doi);
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
            const { dismissedDois, dismissedTitles, dismissedTokenSets } = await loadDismissedSets(context);
            const existingDOIs = new Set([
                ...existingRefs.map(r => r.url).filter(u => u && u.includes('doi.org')).map(u => u.replace(/.*doi\.org\//, '')),
                ...existingRefs.map(r => r.doi).filter(Boolean),
                ...shortlist.map(s => s.doi).filter(Boolean)
            ].map(normalizeValue).filter(Boolean));
            const existingTitles = new Set([
                ...existingRefs.map(r => r.title ? r.title.toLowerCase().trim() : ''),
                ...shortlist.map(s => s.title ? s.title.toLowerCase().trim() : '')
            ].map(normalizeValue).filter(Boolean));
            
            // Relevance keywords
            const RELEVANCE_KEYWORDS = [
                'artificial intelligence', 'AI', 'machine learning', 'generative', 'neural network',
                'deep learning', 'GPT', 'LLM', 'language model', 'diffusion', 'DALL-E', 'Midjourney',
                'ChatGPT', 'creative', 'creativity', 'art', 'artist', 'design', 'designer',
                'music', 'writing', 'author', 'copyright', 'intellectual property', 'automation',
                'labor', 'labour', 'work', 'worker', 'employment', 'job', 'platform', 'gig economy',
                'human-computer', 'HCI', 'interaction', 'co-creation', 'collaboration',
                'media', 'journalism', 'content', 'algorithm', 'computational', 'authorship',
                'creative industries', 'cultural industries', 'precarity', 'deskilling'
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
            try {
                const query = 'SELECT * FROM c ORDER BY c.dateGenerated DESC OFFSET 0 LIMIT 1';
                const analyticsResults = await queryItems(SHORTLIST_CONTAINER, { query });
                if (analyticsResults.length > 0 && analyticsResults[0].gaps) {
                    analyticsGaps = analyticsResults[0].gaps;
                    context.log(`[Newsreader] Found ${analyticsGaps.length} research gaps from analytics`);
                }
            } catch (e) {
                context.warn('[Newsreader] Failed to load analytics gaps:', e.message);
            }

            // Generate gap-based queries
            const gapQueries = [];
            analyticsGaps.forEach(gap => {
                if (gap.searchQueries && Array.isArray(gap.searchQueries)) {
                    gap.searchQueries.forEach(q => {
                        gapQueries.push({
                            query: q,
                            category: `Gap: ${gap.name}`
                        });
                    });
                }
            });

            // Combine queries, prioritizing gaps
            const searchQueries = [...gapQueries, ...baseSearchQueries];
            
            const isRelevantArticle = (title, abstract) => {
                const text = `${title || ''} ${abstract || ''}`.toLowerCase();
                const hasRelevantKeyword = RELEVANCE_KEYWORDS.some(kw => text.includes(kw.toLowerCase()));
                if (!hasRelevantKeyword) return false;
                
                const offTopicPatterns = [
                    /\bhealthcare\b/i, /\bmedical\b/i, /\bclinical\b/i, /\bpatient\b/i,
                    /\bbiological\b/i, /\bchemistry\b/i, /\bphysics\b/i, /\bgeology\b/i,
                    /\bagriculture\b/i, /\bfarming\b/i, /\bcrop\b/i,
                    /\bsports\b/i, /\bathletic\b/i,
                    /\bfinancial\b/i, /\bbanking\b/i, /\bstock\b/i,
                    /\bmilitary\b/i, /\bdefense\b/i, /\bweapon\b/i
                ];
                return !offTopicPatterns.some(pattern => pattern.test(text));
            };
            
            const allArticles = [];
            const now = new Date();
            const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
            const sixMonthsAgo = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
            const oneYearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
            
            const fromDate = filterNew 
                ? sixMonthsAgo.toISOString().split('T')[0]
                : oneYearAgo.toISOString().split('T')[0];
            
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
                const doiKey = normalizeValue(doi);
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
                        if (!year || year < 2020 || year > 2026) continue;
                        
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
                        const typeMap = { 'journal-article': 'Journal Article', 'book-chapter': 'Book Section', 'proceedings-article': 'Conference Paper' };
                        
                        allArticles.push({
                            doi,
                            title,
                            authors: authors || 'Unknown Author',
                            year: String(year),
                            source,
                            type: typeMap[item.type] || 'Article',
                            abstract: item.abstract?.replace(/<[^>]*>/g, '').substring(0, 1000) || '',
                            url: item.URL || (doi ? `https://doi.org/${doi}` : ''),
                            category: sq.category,
                            isNew,
                            publishedDate: pubDate?.toISOString(),
                            apiSource: 'CrossRef',
                            doiKey: normalizeValue(doi),
                            titleKey: normalizeValue(title)
                        });
                    }
                } catch (e) { context.warn('[Newsreader] CrossRef query failed:', sq.query, e.message); }
            }
            
            // Search Semantic Scholar
            for (const sq of searchQueries.slice(0, 4)) {
                try {
                    const ssUrl = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(sq.query)}&limit=8&fields=title,authors,year,abstract,url,venue,publicationDate,externalIds`;
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
                        if (!year || year < 2023 || year > 2026) continue;
                        
                        const pubDate = paper.publicationDate ? new Date(paper.publicationDate) : null;
                        const isNew = pubDate && pubDate >= ninetyDaysAgo;
                        
                        const authors = paper.authors?.map(a => a.name).join('; ') || 'Unknown Author';
                        
                        allArticles.push({
                            doi: doi || paper.paperId,
                            title,
                            authors,
                            year: String(year),
                            source: paper.venue || 'Semantic Scholar',
                            type: 'Article',
                            abstract: paper.abstract?.substring(0, 1000) || '',
                            url: paper.url || (doi ? `https://doi.org/${doi}` : `https://www.semanticscholar.org/paper/${paper.paperId}`),
                            category: sq.category,
                            isNew,
                            publishedDate: pubDate?.toISOString(),
                            apiSource: 'Semantic Scholar',
                            doiKey: normalizeValue(doi || paper.paperId),
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
                            if (!year || year < 2020 || year > 2026) continue;

                            allArticles.push({
                                doi: doi || link,
                                title,
                                authors: item.publication_info?.authors || 'Unknown Author',
                                year: String(year),
                                source: 'Google Scholar',
                                type: 'Article',
                                abstract: abstract.substring(0, 1000),
                                url: link,
                                category: sq.category,
                                isNew: year >= now.getFullYear() - 1,
                                publishedDate: null,
                                apiSource: 'Google Scholar (SerpAPI)',
                                doiKey: normalizeValue(doi || link),
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
                        if (!year || year < 2020 || year > 2026) continue;

                        const isNew = publishedDate && publishedDate >= ninetyDaysAgo;

                        allArticles.push({
                            doi: entry.doi || entry.id,
                            title,
                            authors: entry.authors || 'Unknown Author',
                            year: String(year),
                            source: 'arXiv',
                            type: 'Preprint',
                            abstract: abstract.substring(0, 1000),
                            url: entry.id || (entry.doi ? `https://doi.org/${entry.doi}` : ''),
                            category: sq.category,
                            isNew,
                            publishedDate: publishedDate?.toISOString(),
                            apiSource: 'arXiv',
                            doiKey: normalizeValue(entry.doi || entry.id),
                            titleKey: normalizeValue(title)
                        });
                    }
                } catch (e) { context.warn('[Newsreader] arXiv query failed:', sq.query, e.message); }
            }
            
            // Sort by date (newest first)
            let results = allArticles.sort((a, b) => {
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
