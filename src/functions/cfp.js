const { app } = require('@azure/functions');
const crypto = require('crypto');
const { queryItems, getItem, upsertItem } = require('../../shared/cosmosClient');

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const WIKICFP_SEARCH_BASE = 'http://www.wikicfp.com/cfp/servlet/tool.search';
const REFERENCES_CONTAINER = process.env.COSMOSDB_CONTAINER_REFERENCES || 'references';
const CFP_SETTINGS_CONTAINER = process.env.COSMOSDB_CONTAINER_ANALYTICS || 'analytics';
const KB_REFERENCE_FILTER_CLAUSE = 'c.ref_knowledge_status = 3 AND (NOT IS_DEFINED(c.dismissed) OR c.dismissed != true)';
const KB_REFERENCE_QUERY = `SELECT c.id, c.keywords, c.tags, c.discipline, c.frameworks, c.concepts, c.journal, c.source, c.publisher FROM c WHERE ${KB_REFERENCE_FILTER_CLAUSE}`;
const MAX_KB_QUERY_TERMS = 10;
const MAX_JOURNAL_TERMS = 20;
const MIN_TERM_LENGTH = 3;
const MAX_TERM_LENGTH = 80;
const CURATED_FALLBACK_TERMS = [
    'artificial intelligence',
    'human computer interaction',
    'digital humanities',
    'media studies',
    'creative industries',
    'cultural studies',
    'communication',
    'design research',
    'science and technology studies',
    'platform studies',
    'ai ethics',
    'algorithmic culture'
];
const STOP_TERMS = new Set([
    'research',
    'study',
    'studies',
    'paper',
    'papers',
    'article',
    'articles',
    'journal',
    'journals',
    'conference',
    'conferences',
    'workshop',
    'workshops',
    'special issue',
    'special issues',
    'issue',
    'issues',
    'call for papers',
    'call for submissions',
    'submission',
    'submissions',
    'publication',
    'publications',
    'knowledge base',
    'theory',
    'framework',
    'frameworks',
    'concept',
    'concepts',
    'analysis'
]);

const URGENCY = {
    OVERDUE: 'overdue',
    CRITICAL: 'critical',
    SOON: 'soon',
    UPCOMING: 'upcoming',
    FUTURE: 'future',
    UNKNOWN: 'unknown'
};

const URGENCY_ORDER = [
    URGENCY.CRITICAL,
    URGENCY.SOON,
    URGENCY.UPCOMING,
    URGENCY.FUTURE,
    URGENCY.UNKNOWN,
    URGENCY.OVERDUE
];

let cachedPayload = null;
let cacheWrittenAt = 0;

function base64UrlEncode(value) {
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return buf
        .toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
}

function base64UrlDecodeToString(value) {
    const s = (value || '').toString().replace(/-/g, '+').replace(/_/g, '/');
    const pad = '='.repeat((4 - (s.length % 4)) % 4);
    return Buffer.from(s + pad, 'base64').toString('utf8');
}

function getAuthUser(request) {
    try {
        const header = request.headers.get('authorization') || '';
        const m = header.match(/^Bearer\s+(.+)$/i);
        if (!m) return null;

        const token = m[1];
        const parts = token.split('.');
        if (parts.length !== 3) return null;

        const [headerB64, payloadB64, sigB64] = parts;
        const data = `${headerB64}.${payloadB64}`;
        const secret = process.env.AUTH_JWT_SECRET || 'dev-secret-change-me';

        const expectedSig = base64UrlEncode(
            crypto.createHmac('sha256', secret).update(data).digest()
        );
        if (expectedSig !== sigB64) return null;

        const payloadJson = base64UrlDecodeToString(payloadB64);
        const payload = JSON.parse(payloadJson);
        if (payload?.exp && payload.exp < Date.now() / 1000) return null;
        if (!payload?.email) return null;
        return payload;
    } catch {
        return null;
    }
}

const GLOBAL_DISMISSALS_DOC_ID = 'cfp_dismissals_global';

function normalizeDismissedIds(ids) {
    const raw = Array.isArray(ids) ? ids : [];
    return Array.from(new Set(raw.map((value) => (value || '').toString()).filter(Boolean)));
}

async function readGlobalDismissals() {
    const docId = GLOBAL_DISMISSALS_DOC_ID;
    const existing = await getItem(CFP_SETTINGS_CONTAINER, docId, docId);
    const dismissedIds = normalizeDismissedIds(existing?.dismissedIds);
    return {
        docId,
        existing,
        dismissedIds
    };
}

async function writeGlobalDismissals(nextIds, previous) {
    const docId = GLOBAL_DISMISSALS_DOC_ID;
    const nowIso = new Date().toISOString();
    const baseCreatedAt = previous?.createdAt || nowIso;
    const payload = {
        id: docId,
        type: 'cfp_dismissals_global',
        dismissedIds: normalizeDismissedIds(nextIds),
        updatedAt: nowIso,
        createdAt: baseCreatedAt
    };
    return upsertItem(CFP_SETTINGS_CONTAINER, payload);
}

function splitCandidateValues(value) {
    if (Array.isArray(value)) return value.flatMap(splitCandidateValues);
    return (value || '')
        .toString()
        .split(/\r?\n|;|\||•|,/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function normalizeCandidateTerm(value) {
    const cleaned = (value || '')
        .toString()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/["'`]/g, '')
        .replace(/&/g, ' and ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    if (!cleaned) return '';
    if (cleaned.length < MIN_TERM_LENGTH || cleaned.length > MAX_TERM_LENGTH) return '';
    if (/^\d+$/.test(cleaned)) return '';
    if (STOP_TERMS.has(cleaned)) return '';
    return cleaned;
}

function addWeightedTerm(termMap, value, weight) {
    const normalized = normalizeCandidateTerm(value);
    if (!normalized) return;
    const current = termMap.get(normalized) || { term: normalized, score: 0 };
    current.score += weight;
    termMap.set(normalized, current);
}

function toDisplayQuery(term) {
    return (term || '')
        .split(' ')
        .filter(Boolean)
        .map((part) => {
            if (part === 'ai') return 'AI';
            if (part === 'hci') return 'HCI';
            if (part === 'sts') return 'STS';
            return part.charAt(0).toUpperCase() + part.slice(1);
        })
        .join(' ');
}

async function deriveKBSearchQueries() {
    try {
        const references = await queryItems(REFERENCES_CONTAINER, { query: KB_REFERENCE_QUERY });
        const topicalTerms = new Map();
        const journalTerms = new Map();

        references.forEach((ref) => {
            splitCandidateValues(ref?.keywords).forEach((value) => addWeightedTerm(topicalTerms, value, 4));
            splitCandidateValues(ref?.tags).forEach((value) => addWeightedTerm(topicalTerms, value, 3));
            splitCandidateValues(ref?.discipline).forEach((value) => addWeightedTerm(topicalTerms, value, 4));
            splitCandidateValues(ref?.concepts).forEach((value) => addWeightedTerm(topicalTerms, value, 3));
            splitCandidateValues(ref?.frameworks).forEach((value) => addWeightedTerm(topicalTerms, value, 2));
            splitCandidateValues(ref?.journal || ref?.source || ref?.publisher).forEach((value) => addWeightedTerm(journalTerms, value, 1));
        });

        CURATED_FALLBACK_TERMS.forEach((value) => addWeightedTerm(topicalTerms, value, 2));

        const topQueries = Array.from(topicalTerms.values())
            .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term))
            .slice(0, MAX_KB_QUERY_TERMS)
            .map((item) => item.term);

        const topJournals = Array.from(journalTerms.values())
            .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term))
            .slice(0, MAX_JOURNAL_TERMS)
            .map((item) => item.term);

        const merged = Array.from(new Set([...topQueries, ...topJournals, ...CURATED_FALLBACK_TERMS]))
            .slice(0, MAX_KB_QUERY_TERMS + MAX_JOURNAL_TERMS + CURATED_FALLBACK_TERMS.length)
            .map(toDisplayQuery)
            .filter(Boolean);

        return merged.length ? merged : CURATED_FALLBACK_TERMS.map(toDisplayQuery);
    } catch {
        return CURATED_FALLBACK_TERMS.map(toDisplayQuery);
    }
}

function parseDeadline(dateStr) {
    if (!dateStr || dateStr.trim().toLowerCase() === 'tbd') return null;
    const parsed = new Date(dateStr.trim());
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function decodeHtmlEntities(value) {
    return (value || '')
        .toString()
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
}

function cleanHtmlText(value) {
    return decodeHtmlEntities((value || '')
        .toString()
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim());
}

function sanitizeWikiHtml(html) {
    return (html || '')
        .toString()
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<!--([\s\S]*?)-->/g, ' ');
}

function daysUntilDeadline(isoDate) {
    if (!isoDate) return null;
    const now = new Date();
    const deadline = new Date(isoDate);
    const ms = deadline.getTime();
    if (!Number.isFinite(ms)) return null;
    return Math.ceil((ms - now.getTime()) / (1000 * 60 * 60 * 24));
}

function getUrgency(isoDate) {
    const days = daysUntilDeadline(isoDate);
    if (days === null) return URGENCY.UNKNOWN;
    if (days < 0) return URGENCY.OVERDUE;
    if (days <= 7) return URGENCY.CRITICAL;
    if (days <= 21) return URGENCY.SOON;
    if (days <= 60) return URGENCY.UPCOMING;
    return URGENCY.FUTURE;
}

function enrichCFP(cfp) {
    const days = daysUntilDeadline(cfp.deadline);
    return {
        ...cfp,
        daysUntilDeadline: days,
        urgency: getUrgency(cfp.deadline)
    };
}

function rankByDeadline(cfps) {
    return cfps
        .map(enrichCFP)
        .sort((a, b) => {
            const aOrder = URGENCY_ORDER.indexOf(a.urgency);
            const bOrder = URGENCY_ORDER.indexOf(b.urgency);
            if (aOrder !== bOrder) return aOrder - bOrder;
            if (a.daysUntilDeadline !== null && b.daysUntilDeadline !== null) {
                return a.daysUntilDeadline - b.daysUntilDeadline;
            }
            return 0;
        });
}

function groupByUrgency(rankedCFPs) {
    return rankedCFPs.reduce((groups, cfp) => {
        if (!groups[cfp.urgency]) groups[cfp.urgency] = [];
        groups[cfp.urgency].push(cfp);
        return groups;
    }, {});
}

function aggregateAndRank(cfpArrays) {
    const all = cfpArrays.flat();
    const seenUrls = new Set();
    const unique = all.filter((cfp) => {
        if (!cfp?.url || seenUrls.has(cfp.url)) return false;
        seenUrls.add(cfp.url);
        return true;
    });
    const ranked = rankByDeadline(unique);
    const grouped = groupByUrgency(ranked);
    return {
        ranked,
        grouped,
        meta: {
            total: ranked.length,
            withDeadlines: ranked.filter((item) => item.deadline).length,
            critical: grouped[URGENCY.CRITICAL]?.length || 0,
            soon: grouped[URGENCY.SOON]?.length || 0,
            fetchedAt: new Date().toISOString()
        }
    };
}

async function fetchWikiCFP(query) {
    const url = `${WIKICFP_SEARCH_BASE}?q=${encodeURIComponent(query)}&b=t`;
    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (PhD Helper Dashboard; academic use)'
        }
    });
    if (!res.ok) throw new Error(`WikiCFP fetch failed: ${res.status}`);
    const html = await res.text();
    return parseWikiCFPResults(html, query);
}

function parseWikiCFPResults(html, sourceQuery) {
    const sanitizedHtml = sanitizeWikiHtml(html);
    const cfps = [];
    const rowRegex = /<tr[^>]*>\s*<td[^>]*><a href="(\/cfp\/servlet\/event\.showcfp\?eventid=\d+[^"]*)"[^>]*>([\s\S]*?)<\/a><\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>\s*<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/gi;
    const recentRowRegex = /<tr[^>]*>\s*<td[^>]*rowspan="2"[^>]*><a href="(\/cfp\/servlet\/event\.showcfp\?eventid=\d+[^"]*)"[^>]*>([\s\S]*?)<\/a><\/td>\s*<td[^>]*colspan="3"[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*rowspan="2"[^>]*>[\s\S]*?<\/td>\s*<\/tr>\s*<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/gi;
    let match;
    const seenIds = new Set();

    while ((match = rowRegex.exec(sanitizedHtml)) !== null) {
        const [, path, name, shortName, when, where, deadline, notification] = match;
        const cleanName = cleanHtmlText(name);
        const cleanShortName = cleanHtmlText(shortName);
        const cleanWhen = cleanHtmlText(when);
        const cleanWhere = cleanHtmlText(where);
        const cleanDeadline = cleanHtmlText(deadline);
        const cleanNotification = cleanHtmlText(notification);
        const deadlineDate = parseDeadline(cleanDeadline);
        const eventId = path.match(/eventid=(\d+)/)?.[1] || String(Date.now());
        if (seenIds.has(eventId)) continue;
        seenIds.add(eventId);
        cfps.push({
            id: `wikicfp-${eventId}`,
            source: 'WikiCFP',
            sourceQuery,
            name: cleanName,
            shortName: cleanShortName,
            url: `http://www.wikicfp.com${path}`,
            when: cleanWhen,
            where: cleanWhere,
            deadline: deadlineDate ? deadlineDate.toISOString() : null,
            deadlineRaw: cleanDeadline,
            notification: cleanNotification,
            fetchedAt: new Date().toISOString()
        });
    }

    while ((match = recentRowRegex.exec(sanitizedHtml)) !== null) {
        const [, path, name, description, when, where, deadline] = match;
        const cleanName = cleanHtmlText(name);
        const cleanDescription = cleanHtmlText(description);
        const cleanWhen = cleanHtmlText(when);
        const cleanWhere = cleanHtmlText(where);
        const cleanDeadline = cleanHtmlText(deadline);
        const deadlineDate = parseDeadline(cleanDeadline);
        const eventId = path.match(/eventid=(\d+)/)?.[1] || String(Date.now());
        if (seenIds.has(eventId)) continue;
        seenIds.add(eventId);
        cfps.push({
            id: `wikicfp-${eventId}`,
            source: 'WikiCFP',
            sourceQuery,
            name: cleanName,
            shortName: cleanDescription,
            url: `http://www.wikicfp.com${path}`,
            when: cleanWhen,
            where: cleanWhere,
            deadline: deadlineDate ? deadlineDate.toISOString() : null,
            deadlineRaw: cleanDeadline,
            notification: '',
            fetchedAt: new Date().toISOString()
        });
    }

    return cfps;
}

async function fetchAllWikiCFPs(queries) {
    const results = await Promise.allSettled(queries.map(fetchWikiCFP));
    const allCFPs = results
        .filter((result) => result.status === 'fulfilled')
        .flatMap((result) => result.value);
    const seen = new Set();
    return allCFPs.filter((cfp) => {
        if (!cfp?.id || seen.has(cfp.id)) return false;
        seen.add(cfp.id);
        return true;
    });
}

async function getCFPPayload(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && cachedPayload && (now - cacheWrittenAt) < CACHE_TTL_MS) {
        return { ...cachedPayload, fromCache: true };
    }

    const queries = await deriveKBSearchQueries();
    const sources = await Promise.allSettled([fetchAllWikiCFPs(queries)]);
    const results = sources.map((result) => result.status === 'fulfilled' ? result.value : []);
    const payload = aggregateAndRank(results);
    payload.meta = {
        ...payload.meta,
        queries
    };
    cachedPayload = payload;
    cacheWrittenAt = now;
    return { ...payload, fromCache: false };
}

app.http('GetCFPs', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'cfp',
    handler: async (request, context) => {
        try {
            const forceRefresh = request.query.get('refresh') === '1';
            const payload = await getCFPPayload(forceRefresh);
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            };
        } catch (error) {
            context.error('Get CFPs Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to load CFPs', details: error.message })
            };
        }
    }
});

app.http('GetDismissedCFPs', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'cfp/dismissed',
    handler: async (request, context) => {
        try {
            const { dismissedIds } = await readGlobalDismissals();
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dismissedIds })
            };
        } catch (error) {
            context.error('GetDismissedCFPs Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to retrieve dismissed CFPs', details: error.message })
            };
        }
    }
});

app.http('AddDismissedCFPs', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'cfp/dismissed',
    handler: async (request, context) => {
        try {
            const body = await request.json().catch(() => ({}));
            const incomingIds = normalizeDismissedIds(body?.dismissedIds || (body?.id ? [body.id] : []));
            if (incomingIds.length === 0) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'dismissedIds is required' })
                };
            }

            const { existing, dismissedIds } = await readGlobalDismissals();
            const merged = normalizeDismissedIds([...dismissedIds, ...incomingIds]);
            await writeGlobalDismissals(merged, existing);

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dismissedIds: merged })
            };
        } catch (error) {
            context.error('AddDismissedCFPs Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to store dismissed CFPs', details: error.message })
            };
        }
    }
});
