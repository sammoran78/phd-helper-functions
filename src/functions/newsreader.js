const { app } = require('@azure/functions');
const { queryItems } = require('../../shared/cosmosClient');

// Shortlist stored in CosmosDB analytics container
const SHORTLIST_CONTAINER = process.env.COSMOSDB_CONTAINER_ANALYTICS || 'analytics';
const REFERENCES_CONTAINER = process.env.COSMOSDB_CONTAINER_REFERENCES || 'references';

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
            const shortlist = items.length > 0 ? (items[0].articles || []) : [];
            
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

            const { upsertItem, getItem } = require('../../shared/cosmosClient');
            
            // Get existing shortlist document or create new
            let shortlistDoc = await getItem(SHORTLIST_CONTAINER, 'shortlist', 'shortlist');
            if (!shortlistDoc) {
                shortlistDoc = { id: 'shortlist', type: 'shortlist', articles: [] };
            }
            
            // Check for duplicates
            const exists = shortlistDoc.articles.some(a => 
                a.doi === article.doi || a.title?.toLowerCase() === article.title?.toLowerCase()
            );
            
            if (!exists) {
                shortlistDoc.articles.push({
                    ...article,
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
            const identifier = decodeURIComponent(request.params.identifier);
            const { upsertItem, getItem } = require('../../shared/cosmosClient');
            
            let shortlistDoc = await getItem(SHORTLIST_CONTAINER, 'shortlist', 'shortlist');
            if (!shortlistDoc) {
                return {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ success: true })
                };
            }
            
            shortlistDoc.articles = shortlistDoc.articles.filter(a => 
                a.doi !== identifier && a.title?.toLowerCase() !== identifier.toLowerCase()
            );
            
            await upsertItem(SHORTLIST_CONTAINER, shortlistDoc);
            
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
            const existingDOIs = new Set([
                ...existingRefs.map(r => r.url).filter(u => u && u.includes('doi.org')).map(u => u.replace(/.*doi\.org\//, '')),
                ...existingRefs.map(r => r.doi).filter(Boolean),
                ...shortlist.map(s => s.doi).filter(Boolean)
            ]);
            const existingTitles = new Set([
                ...existingRefs.map(r => r.title ? r.title.toLowerCase().trim() : ''),
                ...shortlist.map(s => s.title ? s.title.toLowerCase().trim() : '')
            ].filter(t => t));
            
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
            const searchQueries = [
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
            
            const isValidArticle = (title, doi, abstract = '') => {
                if (!title || title.length < 10) return false;
                if (/^[\d\.\s]+$/.test(title)) return false;
                if (/^title pending/i.test(title)) return false;
                const titleLower = title.toLowerCase().trim();
                if (doi && existingDOIs.has(doi)) return false;
                if (existingTitles.has(titleLower)) return false;
                if (allArticles.some(a => a.doi === doi || a.title?.toLowerCase() === titleLower)) return false;
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
                            apiSource: 'CrossRef'
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
                            apiSource: 'Semantic Scholar'
                        });
                    }
                } catch (e) { context.warn('[Newsreader] Semantic Scholar query failed:', sq.query, e.message); }
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
            
            context.log(`[Newsreader] Found ${results.length} articles (filter: ${filterNew ? 'new' : 'all'})`);
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(results.slice(0, 30))
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
