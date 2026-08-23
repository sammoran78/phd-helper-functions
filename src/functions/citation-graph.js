const crypto = require('crypto');
const { app } = require('@azure/functions');
const { queryItems, upsertItem } = require('../../shared/cosmosClient');
const { verifyDashboardConfigEditor, verifyDashboardRequest } = require('../../shared/requestAuth');
const { getThesisFraming } = require('../../shared/thesisFraming');
const {
    SCAN_VERSION,
    aggregateCitationGraph,
    resolveCitationReviewProposal,
    scanReferenceCitations
} = require('../../shared/citationGraph');

const REFERENCES_CONTAINER = process.env.COSMOSDB_CONTAINER_REFERENCES || 'references';
const PAGES_CONTAINER = process.env.COSMOSDB_CONTAINER_PAGES || 'pages';
const ANALYTICS_CONTAINER = process.env.COSMOSDB_CONTAINER_ANALYTICS || 'analytics';
const SCAN_TYPE = 'corpus_citation_scan';
const REVIEW_TYPE = 'corpus_citation_review';

const boundedString = (value, maximumLength) => typeof value === 'string'
    ? value.trim().slice(0, maximumLength)
    : null;

const sanitizeSubmittedProposal = (proposal) => {
    if (!proposal || typeof proposal !== 'object') return null;
    const confidence = Number(proposal.confidence);
    const citation = proposal.citation && typeof proposal.citation === 'object'
        ? {
            canonicalKey: boundedString(proposal.citation.canonicalKey, 500),
            doi: boundedString(proposal.citation.doi, 200),
            year: Number(proposal.citation.year) || null,
            authors: boundedString(proposal.citation.authors, 500),
            authorSurname: boundedString(proposal.citation.authorSurname, 200),
            title: boundedString(proposal.citation.title, 1000),
            displayCitation: boundedString(proposal.citation.displayCitation, 2000),
            pageNumber: Number(proposal.citation.pageNumber) || null,
            evidence: boundedString(proposal.citation.evidence, 2500)
        }
        : null;
    const evidence = Array.isArray(proposal.evidence)
        ? proposal.evidence.slice(0, 5).map(item => ({
            pageNumber: Number(item?.pageNumber) || null,
            excerpt: boundedString(item?.excerpt, 2500),
            section: boundedString(item?.section, 100)
        }))
        : [];
    return {
        confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
        reason: boundedString(proposal.reason, 200),
        citation,
        evidence
    };
};

const json = (status, payload) => ({
    status,
    headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, no-cache, must-revalidate'
    },
    body: JSON.stringify(payload)
});

const getBibliographyReferences = () => queryItems(REFERENCES_CONTAINER, {
    query: 'SELECT * FROM c WHERE c.ref_knowledge_status >= 3 AND (NOT IS_DEFINED(c.dismissed) OR c.dismissed != true)'
});

const getCitationScans = () => queryItems(ANALYTICS_CONTAINER, {
    query: 'SELECT * FROM c WHERE c.type = @type',
    parameters: [{ name: '@type', value: SCAN_TYPE }]
});

const getCitationReviews = () => queryItems(ANALYTICS_CONTAINER, {
    query: 'SELECT * FROM c WHERE c.type = @type',
    parameters: [{ name: '@type', value: REVIEW_TYPE }]
});

const getBibliographyReferencesByIds = (sourceReferenceId, targetReferenceId) => queryItems(REFERENCES_CONTAINER, {
    query: `SELECT * FROM c
        WHERE (c.id = @sourceReferenceId OR c.id = @targetReferenceId)
        AND c.ref_knowledge_status >= 3
        AND (NOT IS_DEFINED(c.dismissed) OR c.dismissed != true)`,
    parameters: [
        { name: '@sourceReferenceId', value: sourceReferenceId },
        { name: '@targetReferenceId', value: targetReferenceId }
    ]
});

const getCitationScansForSource = (sourceReferenceId) => queryItems(ANALYTICS_CONTAINER, {
    query: 'SELECT * FROM c WHERE c.type = @type AND c.sourceReferenceId = @sourceReferenceId',
    parameters: [
        { name: '@type', value: SCAN_TYPE },
        { name: '@sourceReferenceId', value: sourceReferenceId }
    ]
});

const getCitationReviewsForProposal = (sourceReferenceId, targetReferenceId, candidateKey) => queryItems(ANALYTICS_CONTAINER, {
    query: `SELECT * FROM c
        WHERE c.type = @type
        AND c.sourceReferenceId = @sourceReferenceId
        AND c.targetReferenceId = @targetReferenceId
        AND c.candidateKey = @candidateKey`,
    parameters: [
        { name: '@type', value: REVIEW_TYPE },
        { name: '@sourceReferenceId', value: sourceReferenceId },
        { name: '@targetReferenceId', value: targetReferenceId },
        { name: '@candidateKey', value: candidateKey }
    ]
});

const referenceFingerprint = (reference) => crypto.createHash('sha256').update(JSON.stringify({
    id: reference.id,
    title: reference.title,
    doi: reference.doi,
    year: reference.year,
    modified: reference.dateModified,
    ocr: reference.kb_ocr_completed,
    vectorized: reference.kb_vectorize_completed,
    pages: reference.kb_total_pages
})).digest('hex').slice(0, 20);

const getCurrentCitationScans = (references, scans) => {
    const referencesById = new Map(references.map(reference => [reference.id, reference]));
    return scans.filter(scan => {
        const reference = referencesById.get(scan.sourceReferenceId);
        return reference
            && scan.scanVersion === SCAN_VERSION
            && scan.sourceFingerprint === referenceFingerprint(reference);
    });
};

const scanOneReference = async (reference, references, previousScan, context) => {
    const pages = await queryItems(PAGES_CONTAINER, {
        query: 'SELECT c.id, c.referenceId, c.pageNumber, c.pdfPageNumber, c.ocrText FROM c WHERE c.referenceId = @referenceId AND IS_STRING(c.ocrText)',
        parameters: [{ name: '@referenceId', value: reference.id }]
    });
    const result = scanReferenceCitations(reference, pages, references);
    const now = new Date().toISOString();
    const scan = {
        id: `citation_scan_${reference.id}`,
        type: SCAN_TYPE,
        sourceReferenceId: reference.id,
        sourceFingerprint: referenceFingerprint(reference),
        scanVersion: SCAN_VERSION,
        status: pages.length ? 'complete' : 'no_ocr_text',
        pagesExamined: pages.length,
        candidateCount: result.candidateCount,
        edges: result.edges,
        ambiguousMatches: result.ambiguousMatches,
        missingWorks: result.missingWorks,
        createdAt: previousScan?.createdAt || now,
        updatedAt: now
    };
    await upsertItem(ANALYTICS_CONTAINER, scan);
    context?.log?.('[Corpus Graph] Scanned reference', {
        referenceId: reference.id,
        pages: pages.length,
        edges: result.edges.length,
        missingWorks: result.missingWorks.length
    });
    return scan;
};

const scanCorpusBatch = async ({ batchSize = 1, force = false } = {}, context) => {
    const [references, scans] = await Promise.all([getBibliographyReferences(), getCitationScans()]);
    const scansBySource = new Map(scans.map(scan => [scan.sourceReferenceId, scan]));
    const pending = references.filter(reference => {
        const scan = scansBySource.get(reference.id);
        return force
            || !scan
            || scan.scanVersion !== SCAN_VERSION
            || scan.sourceFingerprint !== referenceFingerprint(reference);
    });
    const selected = pending.slice(0, Math.max(1, Math.min(10, Number(batchSize) || 1)));
    const completed = [];
    for (const reference of selected) {
        completed.push(await scanOneReference(reference, references, scansBySource.get(reference.id), context));
    }
    return {
        bibliographyCount: references.length,
        processed: completed.length,
        processedReferenceIds: completed.map(scan => scan.sourceReferenceId),
        remaining: Math.max(0, pending.length - completed.length)
    };
};

app.http('GetCorpusCitationGraph', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'corpus-graph',
    handler: async (request, context) => {
        if (!verifyDashboardRequest(request)) return json(401, { error: 'Unauthorized' });
        try {
            const [references, scans, reviews, framing] = await Promise.all([
                getBibliographyReferences(),
                getCitationScans(),
                getCitationReviews(),
                getThesisFraming().catch(() => null)
            ]);
            const currentScans = getCurrentCitationScans(references, scans);
            const graph = aggregateCitationGraph(references, currentScans, reviews);
            const scansBySource = new Map(scans.map(scan => [scan.sourceReferenceId, scan]));
            const scannedReferenceIds = references.filter(reference => {
                const scan = scansBySource.get(reference.id);
                return scan?.scanVersion === SCAN_VERSION && scan?.sourceFingerprint === referenceFingerprint(reference);
            }).map(reference => reference.id);
            const scanned = scannedReferenceIds.length;
            return json(200, {
                ...graph,
                scannedReferenceIds,
                missingWorkCount: graph.missingWorks.length,
                missingWorks: graph.missingWorks.slice(0, 200),
                progress: {
                    scanned,
                    total: references.length,
                    remaining: Math.max(0, references.length - scanned),
                    percentage: references.length ? Math.round((scanned / references.length) * 100) : 100,
                    lastUpdatedAt: scans.map(scan => scan.updatedAt).filter(Boolean).sort().at(-1) || null
                },
                subQuestions: framing?.subQuestions || []
            });
        } catch (error) {
            context.error('[Corpus Graph] Load failed:', error);
            return json(500, { error: 'Failed to load corpus citation graph', details: error.message });
        }
    }
});

app.http('ReviewCorpusCitationMatch', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'corpus-graph/review',
    handler: async (request, context) => {
        if (!verifyDashboardRequest(request)) return json(401, { error: 'Unauthorized' });
        if (!verifyDashboardConfigEditor(request)) return json(403, { error: 'Forbidden' });
        try {
            const body = await request.json();
            const sourceReferenceId = (body?.sourceReferenceId || '').toString().trim();
            const targetReferenceId = (body?.targetReferenceId || '').toString().trim();
            const candidateKey = (body?.candidateKey || '').toString().trim();
            const decision = body?.decision === 'confirmed' ? 'confirmed' : (body?.decision === 'rejected' ? 'rejected' : '');
            if (!sourceReferenceId || !targetReferenceId || !candidateKey || !decision) {
                return json(400, { error: 'sourceReferenceId, targetReferenceId, candidateKey, and a confirmed/rejected decision are required' });
            }
            const [references, scans, reviews] = await Promise.all([
                getBibliographyReferencesByIds(sourceReferenceId, targetReferenceId),
                getCitationScansForSource(sourceReferenceId),
                getCitationReviewsForProposal(sourceReferenceId, targetReferenceId, candidateKey)
            ]);
            const referencesById = new Map(references.map(reference => [reference.id, reference]));
            if (!referencesById.has(sourceReferenceId) || !referencesById.has(targetReferenceId)) {
                return json(404, { error: 'The source or target bibliography work was not found' });
            }
            if (sourceReferenceId === targetReferenceId) {
                return json(400, { error: 'A bibliography work cannot cite itself' });
            }
            const currentScans = getCurrentCitationScans(references, scans);
            const {
                proposal: match,
                proposalStateAtReview,
                existingReview
            } = resolveCitationReviewProposal({
                sourceReferenceId,
                targetReferenceId,
                candidateKey,
                graph: { ambiguousMatches: [] },
                scans: currentScans,
                reviews,
                submittedProposal: sanitizeSubmittedProposal(body?.proposal)
            });

            const now = new Date().toISOString();
            const confidenceBeforeReview = Number(match.confidence ?? match.confidenceBeforeReview);
            const digest = crypto.createHash('sha256')
                .update(`${sourceReferenceId}|${candidateKey}|${targetReferenceId}`)
                .digest('hex')
                .slice(0, 24);
            const review = await upsertItem(ANALYTICS_CONTAINER, {
                id: `citation_review_${digest}`,
                type: REVIEW_TYPE,
                sourceReferenceId,
                targetReferenceId,
                candidateKey,
                decision,
                confidenceBeforeReview: Number.isFinite(confidenceBeforeReview) ? confidenceBeforeReview : null,
                reason: match.reason || existingReview?.reason || null,
                citation: match.citation || existingReview?.citation || null,
                evidence: Array.isArray(match.evidence) ? match.evidence : (existingReview?.evidence || []),
                proposalStateAtReview,
                createdAt: existingReview?.createdAt || existingReview?.reviewedAt || now,
                reviewedAt: now,
                updatedAt: now
            });
            return json(200, {
                review,
                edge: decision === 'confirmed' ? {
                    sourceReferenceId,
                    targetReferenceId,
                    matchType: 'human_verified',
                    confidence: 1,
                    evidence: review.evidence || [],
                    reviewedAt: review.reviewedAt
                } : null,
                decisionScope: decision === 'confirmed' ? 'source_target_pair' : 'candidate',
                refreshRequired: true,
                acceptedStaleProposal: !['pending', 'scan_present'].includes(proposalStateAtReview)
            });
        } catch (error) {
            context.error('[Corpus Graph] Review failed:', error);
            return json(500, { error: 'Failed to save citation review', details: error.message });
        }
    }
});

app.http('ScanCorpusCitationGraph', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'corpus-graph/scan',
    handler: async (request, context) => {
        if (!verifyDashboardRequest(request)) return json(401, { error: 'Unauthorized' });
        try {
            const body = await request.json().catch(() => ({}));
            return json(200, await scanCorpusBatch({
                batchSize: body?.batchSize,
                force: body?.force === true
            }, context));
        } catch (error) {
            context.error('[Corpus Graph] Scan failed:', error);
            return json(500, { error: 'Failed to scan corpus citations', details: error.message });
        }
    }
});

app.timer('IncrementalCorpusCitationScan', {
    schedule: process.env.CORPUS_GRAPH_SCAN_SCHEDULE || '0 */30 * * * *',
    runOnStartup: false,
    handler: async (_timer, context) => {
        if ((process.env.CORPUS_GRAPH_TIMER_ENABLED || 'true').toLowerCase() === 'false') return;
        try {
            const result = await scanCorpusBatch({ batchSize: 1 }, context);
            context.log('[Corpus Graph] Incremental scan complete', result);
        } catch (error) {
            context.error('[Corpus Graph] Incremental scan failed:', error);
        }
    }
});

module.exports = {
    referenceFingerprint,
    scanCorpusBatch
};
