const { app } = require('@azure/functions');
const { queryItems, createItem, getItem, upsertItem, deleteItem } = require('../../shared/cosmosClient');
const { Document, Packer, Paragraph, TextRun } = require('docx');

const CONTAINER_NAME = process.env.COSMOSDB_CONTAINER_REFERENCES || 'references';
const SHORTLIST_CONTAINER = process.env.COSMOSDB_CONTAINER_ANALYTICS || 'analytics';
const SHORTLIST_ID = 'shortlist';

const normalizeValue = (value) => (value || '').toString().trim().toLowerCase();

const normalizeSortKey = (value) => {
    const s = (value || '').toString();
    return s
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[\u200B\u200E\u200F\uFEFF]/g, '')
        .trim()
        .toLowerCase();
};

const extractPrimaryAuthorToken = (reference) => {
    // Prioritize the explicit authors/author field
    let s = (reference?.authors || reference?.author || '').toString().trim();
    
    // If no authors field, try to extract from apa7 citation (format: "Author. (Year). Title...")
    if (!s) {
        const apa7 = (reference?.apa7 || '').toString();
        // Match author pattern at the start: everything before the year in parens
        const match = apa7.match(/^([^.]+\.\s+)?\(/);
        if (match) {
            s = apa7.slice(0, match.index).trim();
        }
    }
    
    if (!s) return '';

    // Remove leading non-alphabetic characters
    s = s.replace(/^[^A-Za-z]+/g, '').trim();

    // For "Surname, Initials & Surname, Initials" format - keep first author only
    // Split on & first to get just the first author
    s = s.split(/\s+&\s+/)[0].trim();
    
    // Split on comma to get just the surname (handles "Surname, A." format)
    const commaIdx = s.indexOf(',');
    if (commaIdx > 0) {
        s = s.slice(0, commaIdx).trim();
    }

    // Clean up any remaining punctuation
    s = s.replace(/[.\s]+$/g, '').trim();
    
    return s;
};

const getBibliographySortKey = (reference) => {
    // Sort by the full APA7 citation text character-by-character
    const apa7Key = normalizeSortKey(reference?.apa7);
    if (apa7Key) return apa7Key;

    // Fallback: sort by authors then title
    const authorKey = normalizeSortKey(reference?.authors || reference?.author);
    if (authorKey) return authorKey;

    const titleKey = normalizeSortKey(reference?.title);
    if (titleKey) return titleKey;

    return normalizeSortKey(reference?.id);
};

const sortBibliographyReferences = (references) => {
    const list = Array.isArray(references) ? references : [];
    return list.sort((a, b) => {
        const keyA = getBibliographySortKey(a);
        const keyB = getBibliographySortKey(b);
        const cmp = keyA.localeCompare(keyB, undefined, { sensitivity: 'base' });
        if (cmp !== 0) return cmp;

        const titleA = normalizeSortKey(a?.title);
        const titleB = normalizeSortKey(b?.title);
        const tcmp = titleA.localeCompare(titleB, undefined, { sensitivity: 'base' });
        if (tcmp !== 0) return tcmp;

        return normalizeSortKey(a?.id).localeCompare(normalizeSortKey(b?.id));
    });
};

const getReferenceKeys = (reference) => {
    const doiKey = normalizeValue(reference?.doi);
    const titleKey = normalizeValue(reference?.title);
    return { doiKey, titleKey };
};

const removeFromShortlistByKeys = async (doiKey, titleKey, context) => {
    if (!doiKey && !titleKey) return;
    const shortlistDoc = await getItem(SHORTLIST_CONTAINER, SHORTLIST_ID, SHORTLIST_ID);
    if (!shortlistDoc || !Array.isArray(shortlistDoc.articles)) return;

    const filtered = shortlistDoc.articles.filter(article => {
        const articleDoiKey = normalizeValue(article?.doiKey || article?.doi);
        const articleTitleKey = normalizeValue(article?.titleKey || article?.title);
        if (doiKey && articleDoiKey === doiKey) return false;
        if (titleKey && articleTitleKey === titleKey) return false;
        return true;
    });

    if (filtered.length !== shortlistDoc.articles.length) {
        shortlistDoc.articles = filtered;
        await upsertItem(SHORTLIST_CONTAINER, shortlistDoc);
        context?.log('Removed reference from shortlist');
    }
};

// GET /api/references - Get all references
app.http('GetReferences', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'references',
    handler: async (request, context) => {
        try {
            context.log('Loading references from CosmosDB');
            
            const querySpec = {
                query: 'SELECT * FROM c WHERE (NOT IS_DEFINED(c.dismissed) OR c.dismissed != true) ORDER BY c._ts DESC'
            };
            
            const references = await queryItems(CONTAINER_NAME, querySpec);
            
            context.log(`Loaded ${references.length} references`);
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(references)
            };
        } catch (error) {
            context.error('Get References Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to load references', details: error.message })
            };
        }
    }
});

// POST /api/references - Create a new reference
app.http('CreateReference', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'references',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            
            const newReference = {
                id: `ref_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                ...body,
                dateAdded: new Date().toISOString()
            };
            
            const created = await createItem(CONTAINER_NAME, newReference);

            const { doiKey, titleKey } = getReferenceKeys(created);
            await removeFromShortlistByKeys(doiKey, titleKey, context);
            
            context.log(`Created reference: ${created.id}`);
            
            return {
                status: 201,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(created)
            };
        } catch (error) {
            context.error('Create Reference Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to create reference', details: error.message })
            };
        }
    }
});

// PUT /api/references/{id} - Update a reference
app.http('UpdateReference', {
    methods: ['PUT'],
    authLevel: 'anonymous',
    route: 'references/{id}',
    handler: async (request, context) => {
        try {
            const id = request.params.id;
            const body = await request.json();
            
            const existing = await getItem(CONTAINER_NAME, id, id);
            if (!existing) {
                return {
                    status: 404,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Reference not found' })
                };
            }
            
            const updatedReference = {
                ...existing,
                ...body,
                id: id,
                dateModified: new Date().toISOString()
            };
            
            const updated = await upsertItem(CONTAINER_NAME, updatedReference);

            const existingKeys = getReferenceKeys(existing);
            const updatedKeys = getReferenceKeys(updatedReference);
            await removeFromShortlistByKeys(existingKeys.doiKey, existingKeys.titleKey, context);
            await removeFromShortlistByKeys(updatedKeys.doiKey, updatedKeys.titleKey, context);
            
            context.log(`Updated reference: ${id}`);
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updated)
            };
        } catch (error) {
            context.error('Update Reference Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to update reference', details: error.message })
            };
        }
    }
});

// GET /api/references/bibliography - Get references with ref_knowledge_status>=3 for bibliography
app.http('GetBibliography', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'references/bibliography',
    handler: async (request, context) => {
        try {
            context.log('Loading bibliography references (status>=3) from CosmosDB');
            
            const querySpec = {
                query: 'SELECT * FROM c WHERE c.ref_knowledge_status >= 3 AND (NOT IS_DEFINED(c.dismissed) OR c.dismissed != true)'
            };
            
            const references = await queryItems(CONTAINER_NAME, querySpec);

            const sorted = sortBibliographyReferences(references);
            
            context.log(`Loaded ${sorted.length} bibliography references`);
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(sorted)
            };
        } catch (error) {
            context.error('Get Bibliography Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to load bibliography', details: error.message })
            };
        }
    }
});

function parseSimpleMarkdownRuns(text) {
    const s = (text || '').toString();
    const runs = [];
    let i = 0;

    const pushRun = (value, opts) => {
        if (!value) return;
        runs.push(new TextRun({
            text: value,
            font: 'Times New Roman',
            size: 22,
            ...opts
        }));
    };

    while (i < s.length) {
        const isBold = s.startsWith('**', i);
        const isItalic = s.startsWith('*', i);

        if (isBold) {
            const end = s.indexOf('**', i + 2);
            if (end !== -1) {
                pushRun(s.slice(i + 2, end), { bold: true });
                i = end + 2;
                continue;
            }
        }

        if (isItalic) {
            const end = s.indexOf('*', i + 1);
            if (end !== -1) {
                pushRun(s.slice(i + 1, end), { italics: true });
                i = end + 1;
                continue;
            }
        }

        const nextBold = s.indexOf('**', i);
        const nextItalic = s.indexOf('*', i);
        let next = -1;
        if (nextBold !== -1 && nextItalic !== -1) next = Math.min(nextBold, nextItalic);
        else next = nextBold !== -1 ? nextBold : nextItalic;

        if (next === -1) {
            pushRun(s.slice(i), {});
            break;
        }

        pushRun(s.slice(i, next), {});
        i = next;
    }

    return runs;
}

// GET /api/references/bibliography/export-docx - Export bibliography list as DOCX
app.http('ExportBibliographyDocx', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'references/bibliography/export-docx',
    handler: async (request, context) => {
        try {
            context.log('Exporting bibliography to DOCX');

            const references = await queryItems(CONTAINER_NAME, {
                query: 'SELECT * FROM c WHERE c.ref_knowledge_status >= 3 AND (NOT IS_DEFINED(c.dismissed) OR c.dismissed != true)'
            });

            const sorted = sortBibliographyReferences(references);

            const paragraphs = sorted.map(ref => {
                const apa7 = (ref.apa7 || '').toString().trim();
                const fallback = `${ref.authors || ref.author || 'Unknown Author'} (${ref.year || 'n.d.'}). ${ref.title || 'Untitled'}.`;
                const text = apa7 || fallback;

                return new Paragraph({
                    children: parseSimpleMarkdownRuns(text),
                    indent: { left: 720, hanging: 720 },
                    spacing: { after: 240 }
                });
            });

            const doc = new Document({
                sections: [
                    {
                        properties: {},
                        children: paragraphs.length > 0 ? paragraphs : [
                            new Paragraph({
                                children: [new TextRun({ text: 'No bibliography entries.', font: 'Times New Roman', size: 22 })]
                            })
                        ]
                    }
                ]
            });

            const buffer = await Packer.toBuffer(doc);
            const fileName = `bibliography_${new Date().toISOString().slice(0, 10)}.docx`;

            return {
                status: 200,
                isRaw: true,
                headers: {
                    'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                    'Content-Disposition': `attachment; filename="${fileName}"`
                },
                body: buffer
            };
        } catch (error) {
            context.error('Export Bibliography DOCX Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to export bibliography', details: error.message })
            };
        }
    }
});

// DELETE /api/references/{id} - Delete a reference
app.http('DeleteReference', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'references/{id}',
    handler: async (request, context) => {
        try {
            const id = request.params.id;
            
            await deleteItem(CONTAINER_NAME, id, id);
            
            context.log(`Deleted reference: ${id}`);
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true, message: 'Reference deleted' })
            };
        } catch (error) {
            context.error('Delete Reference Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to delete reference', details: error.message })
            };
        }
    }
});
