const { app } = require('@azure/functions');

const safeJson = async (res) => {
    const text = await res.text();
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
};

app.http('GetDoi', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'doi/{*doi}',
    handler: async (request, context) => {
        try {
            let doi = request.params.doi;
            try {
                doi = decodeURIComponent(doi);
            } catch {}

            if (!doi) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'DOI is required' })
                };
            }

            const crossrefUrl = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
            const crossrefRes = await fetch(crossrefUrl, {
                headers: {
                    'User-Agent': 'phd-helper/1.0 (mailto:admin@phd-helper.local)'
                }
            });

            if (crossrefRes.ok) {
                const data = await safeJson(crossrefRes);
                if (!data) {
                    return {
                        status: 502,
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ error: 'CrossRef returned an invalid response' })
                    };
                }

                return {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                };
            }

            const dataciteUrl = `https://api.datacite.org/dois/${encodeURIComponent(doi)}`;
            const dataciteRes = await fetch(dataciteUrl);

            if (!dataciteRes.ok) {
                const isNotFound = crossrefRes.status === 404 && dataciteRes.status === 404;
                return {
                    status: isNotFound ? 404 : 502,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        error: isNotFound
                            ? 'DOI not found'
                            : `DOI lookup failed (CrossRef ${crossrefRes.status}, DataCite ${dataciteRes.status})`
                    })
                };
            }

            const datacite = await safeJson(dataciteRes);
            const attrs = datacite?.data?.attributes || {};

            const title = Array.isArray(attrs.titles) && attrs.titles.length > 0
                ? (attrs.titles[0]?.title ? [attrs.titles[0].title] : [])
                : [];

            const author = Array.isArray(attrs.creators)
                ? attrs.creators.map((c) => {
                    const family = c.familyName || (c.name ? c.name.split(',')[0]?.trim() : undefined);
                    const given = c.givenName || (c.name && c.name.includes(',') ? c.name.split(',')[1]?.trim() : undefined);
                    const name = c.name || c.creatorName;
                    if (family || given) return { family, given };
                    if (name) return { name };
                    return { name: 'Unknown' };
                })
                : [];

            const year = attrs.publicationYear ? String(attrs.publicationYear) : '';
            const containerTitle = attrs.publisher || 'DataCite';
            const url = attrs.url || (attrs.doi ? `https://doi.org/${attrs.doi}` : `https://doi.org/${doi}`);

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    status: 'ok',
                    message: {
                        title,
                        author,
                        published: year ? { 'date-parts': [[parseInt(year, 10)]] } : undefined,
                        type: 'journal-article',
                        'container-title': containerTitle ? [containerTitle] : [],
                        publisher: attrs.publisher || undefined,
                        DOI: attrs.doi || doi,
                        URL: url
                    }
                })
            };
        } catch (err) {
            context.error('DOI Lookup Error:', err);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'DOI lookup failed', details: err?.message || String(err) })
            };
        }
    }
});
