const { app } = require('@azure/functions');

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const WIKICFP_SEARCH_BASE = 'http://www.wikicfp.com/cfp/servlet/tool.search';
const DEFAULT_SEARCH_QUERIES = [
    'creative AI',
    'generative AI creative industries',
    'AI copyright',
    'AI labour',
    'creative workers AI',
    'human AI collaboration',
    'AI governance creative',
    'digital labour'
];

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

function parseDeadline(dateStr) {
    if (!dateStr || dateStr.trim().toLowerCase() === 'tbd') return null;
    const parsed = new Date(dateStr.trim());
    return Number.isNaN(parsed.getTime()) ? null : parsed;
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
    const cfps = [];
    const rowRegex = /<tr[^>]*>\s*<td[^>]*><a href="(\/cfp\/servlet\/event\.showcfp\?eventid=\d+[^"]*)"[^>]*>([^<]+)<\/a><\/td>\s*<td[^>]*>([^<]*)<\/td>\s*<\/tr>\s*<tr[^>]*>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>/gi;
    let match;

    while ((match = rowRegex.exec(html)) !== null) {
        const [, path, name, shortName, when, where, deadline, notification] = match;
        const deadlineDate = parseDeadline(deadline);
        const eventId = path.match(/eventid=(\d+)/)?.[1] || String(Date.now());
        cfps.push({
            id: `wikicfp-${eventId}`,
            source: 'WikiCFP',
            sourceQuery,
            name: (name || '').trim(),
            shortName: (shortName || '').trim(),
            url: `http://www.wikicfp.com${path}`,
            when: (when || '').trim(),
            where: (where || '').trim(),
            deadline: deadlineDate ? deadlineDate.toISOString() : null,
            deadlineRaw: (deadline || '').trim(),
            notification: (notification || '').trim(),
            fetchedAt: new Date().toISOString()
        });
    }

    return cfps;
}

async function fetchAllWikiCFPs(queries = DEFAULT_SEARCH_QUERIES) {
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

    const sources = await Promise.allSettled([fetchAllWikiCFPs()]);
    const results = sources.map((result) => result.status === 'fulfilled' ? result.value : []);
    const payload = aggregateAndRank(results);
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
