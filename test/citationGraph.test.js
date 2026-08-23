const test = require('node:test');
const assert = require('node:assert/strict');

const {
    aggregateCitationGraph,
    extractReferenceEntries,
    normalizeDoi,
    resolveCitationReviewProposal,
    scanReferenceCitations
} = require('../shared/citationGraph');

const references = [
    { id: 'source-a', title: 'Current Creative Practice', authors: 'Smith, A.', year: 2024, discipline: 'Creative Arts' },
    { id: 'target-b', title: 'Creative Agency and Artificial Intelligence', authors: 'Jones, B.', year: 2020, doi: '10.1234/agency.2020', discipline: 'HCI' },
    { id: 'source-c', title: 'Later Creative Work', authors: 'Taylor, D.', year: 2025, discipline: 'Creative Arts' }
];

const pages = [{
    pageNumber: 10,
    ocrText: [
        'References',
        'Jones, B. (2020). Creative Agency and Artificial Intelligence. Journal. https://doi.org/10.1234/agency.2020',
        'Brown, C. (2019). Overlooked Creative Labour. Other Journal.'
    ].join('\n')
}];

test('normalizes DOI URLs and trailing punctuation', () => {
    assert.equal(normalizeDoi('https://doi.org/10.1234/AGENCY.2020.'), '10.1234/agency.2020');
});

test('extracts structured candidates from an OCR bibliography', () => {
    const entries = extractReferenceEntries(pages);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].doi, '10.1234/agency.2020');
    assert.equal(entries[1].title, 'Overlooked Creative Labour');
    assert.equal(entries[1].pageNumber, 10);
});

test('separates Harvard-style references and rejects the unrelated Beyond Justice suggestion', () => {
    const screenshotPages = [{
        pageNumber: 33,
        ocrText: [
            'References',
            'Selvefors, A. 2017 Design beyond Interventions. Supporting Less Energy-Reliant Activities in the Everyday. Chalmers University of Technology.',
            'Selvefors, A., Karlsson, I. C. & Rahe, U. 2015 Conflicts in everyday life: the influence of competing goals on domestic energy conservation.',
            'Sustainability 7, 5963–5980; doi:10.3390/su7055963.',
            'Shove, E. 2007 The Design of Everyday Life. Berg.',
            '--- 33/34 https://doi.org/10.1017/dsj.2021.17 Published online by Cambridge University Press'
        ].join('\n')
    }];
    const entries = extractReferenceEntries(screenshotPages);
    assert.equal(entries.length, 3);
    assert.equal(entries[0].authors, 'Selvefors, A.');
    assert.equal(entries[1].authors, 'Selvefors, A., Karlsson, I. C. & Rahe, U.');
    assert.equal(entries[2].authors, 'Shove, E.');
    assert.equal(entries[2].doi, null);

    const result = scanReferenceCitations(
        { id: 'source', title: 'A meta-synthesis of activity theory', authors: 'Boks, C.', year: 2021 },
        screenshotPages,
        [
            { id: 'source', title: 'A meta-synthesis of activity theory', authors: 'Boks, C.', year: 2021 },
            { id: 'unrelated', title: 'Beyond Justice', authors: 'Viehoff, Juri', year: 2022 }
        ]
    );
    assert.equal(result.ambiguousMatches.length, 0);
    assert.equal(result.edges.length, 0);
});

test('queues even an exact DOI match for human confirmation', () => {
    const result = scanReferenceCitations(references[0], pages, references);
    assert.equal(result.edges.length, 0);
    assert.equal(result.ambiguousMatches.length, 1);
    assert.equal(result.ambiguousMatches[0].targetReferenceId, 'target-b');
    assert.equal(result.ambiguousMatches[0].reason, 'doi');
    assert.match(result.ambiguousMatches[0].evidence[0].excerpt, /Creative Agency/);
});

test('requires a corpus author surname even when the DOI and title match', () => {
    const wrongAuthorPages = [{
        pageNumber: 4,
        ocrText: 'References\nWrong, Z. (2020). Creative Agency and Artificial Intelligence. https://doi.org/10.1234/agency.2020'
    }];
    const result = scanReferenceCitations(references[0], wrongAuthorPages, references);
    assert.equal(result.edges.length, 0);
    assert.equal(result.ambiguousMatches.length, 0);
    assert.equal(result.missingWorks.length, 1);
});

test('aggregates only human-confirmed edges and shared missing citations', () => {
    const match = {
        sourceReferenceId: 'source-a',
        targetReferenceId: 'target-b',
        candidateKey: 'doi:10.1234/agency.2020',
        confidence: 1,
        reason: 'doi'
    };
    const scanA = {
        sourceReferenceId: 'source-a',
        edges: [],
        ambiguousMatches: [match],
        missingWorks: [
            { canonicalKey: 'doi:10.1234/agency.2020', doi: '10.1234/agency.2020', title: 'Creative Agency and Artificial Intelligence', authors: 'Jones, B.', year: 2020, occurrenceCount: 1 },
            { canonicalKey: 'brown|2019|overlooked creative labour', title: 'Overlooked Creative Labour', authors: 'Brown, C.', year: 2019, occurrenceCount: 1 }
        ]
    };
    const scanC = {
        sourceReferenceId: 'source-c',
        edges: [],
        missingWorks: [{ canonicalKey: 'brown|2019|overlooked creative labour', title: 'Overlooked Creative Labour', authors: 'Brown, C.', year: 2019, occurrenceCount: 1 }]
    };
    const graph = aggregateCitationGraph(references, [scanA, scanC], [{ ...match, decision: 'confirmed', reviewedAt: '2026-08-23T00:00:00Z' }]);
    assert.equal(graph.edges.length, 1);
    assert.equal(graph.edges[0].matchType, 'human_verified');
    assert.equal(graph.nodes.find(node => node.id === 'source-a').outbound, 1);
    assert.equal(graph.nodes.find(node => node.id === 'target-b').inbound, 1);
    assert.deepEqual(graph.missingWorks[0].citedBySourceIds.sort(), ['source-a', 'source-c']);
});

test('queues a formerly missing work for review when it is later added to the corpus', () => {
    const scan = {
        sourceReferenceId: 'source-a',
        edges: [],
        missingWorks: [{
            canonicalKey: 'doi:10.1234/agency.2020',
            doi: '10.1234/agency.2020',
            title: 'Creative Agency and Artificial Intelligence',
            authors: 'Jones, B.',
            year: 2020,
            occurrenceCount: 1
        }]
    };
    const graph = aggregateCitationGraph(references, [scan]);
    assert.equal(graph.missingWorks.length, 0);
    assert.equal(graph.edges.length, 0);
    assert.equal(graph.ambiguousMatches.length, 1);
    assert.equal(graph.ambiguousMatches[0].targetReferenceId, 'target-b');
    assert.equal(graph.ambiguousMatches[0].reason, 'reconciled_doi');
});

test('queues plausible author-year/title matches for human review', () => {
    const corpus = [
        { id: 'source', title: 'Source Work', authors: 'Smith, A.', year: 2024 },
        { id: 'possible', title: 'Creative Agency in Generative Systems', authors: 'Morgan, P.', year: 2021 }
    ];
    const ambiguousPages = [{
        pageNumber: 12,
        ocrText: 'References\nMorgan, P. (2021). Creative Agency with Automated Tools. Journal of AI.'
    }];
    const result = scanReferenceCitations(corpus[0], ambiguousPages, corpus);
    assert.equal(result.edges.length, 0);
    assert.equal(result.ambiguousMatches.length, 1);
    assert.equal(result.ambiguousMatches[0].targetReferenceId, 'possible');
    assert.ok(result.ambiguousMatches[0].confidence < 0.88);
});

test('human confirmation promotes an ambiguous match and removes it from the missing queue', () => {
    const match = {
        sourceReferenceId: 'source-a',
        targetReferenceId: 'target-b',
        candidateKey: 'candidate-one',
        confidence: 0.67,
        evidence: [{ pageNumber: 9, excerpt: 'Possible citation' }]
    };
    const scan = {
        sourceReferenceId: 'source-a',
        edges: [],
        ambiguousMatches: [match],
        missingWorks: [{ canonicalKey: 'candidate-one', title: 'Possible citation', occurrenceCount: 1 }]
    };
    const graph = aggregateCitationGraph(references, [scan], [{
        ...match,
        decision: 'confirmed',
        reviewedAt: '2026-08-23T00:00:00Z'
    }]);
    assert.equal(graph.ambiguousMatches.length, 0);
    assert.equal(graph.missingWorks.length, 0);
    assert.equal(graph.edges[0].matchType, 'human_verified');
    assert.equal(graph.edges[0].confidence, 1);
});

test('human rejection removes only that proposed match and retains the overlooked citation', () => {
    const match = {
        sourceReferenceId: 'source-a',
        targetReferenceId: 'target-b',
        candidateKey: 'candidate-two',
        confidence: 0.62
    };
    const scan = {
        sourceReferenceId: 'source-a',
        edges: [],
        ambiguousMatches: [match],
        missingWorks: [{ canonicalKey: 'candidate-two', title: 'Still overlooked', occurrenceCount: 1 }]
    };
    const graph = aggregateCitationGraph(references, [scan], [{ ...match, decision: 'rejected' }]);
    assert.equal(graph.ambiguousMatches.length, 0);
    assert.equal(graph.edges.length, 0);
    assert.equal(graph.missingWorks[0].title, 'Still overlooked');
});

test('resolves the exact stale proposal submitted by the review card', () => {
    const resolved = resolveCitationReviewProposal({
        sourceReferenceId: 'source-a',
        targetReferenceId: 'target-b',
        candidateKey: 'stale-candidate',
        graph: { ambiguousMatches: [] },
        scans: [],
        reviews: [],
        submittedProposal: {
            confidence: 0.73,
            reason: 'doi',
            citation: { displayCitation: 'Jones, B. (2020). Creative Agency.' }
        }
    });
    assert.equal(resolved.proposalStateAtReview, 'stale_snapshot');
    assert.equal(resolved.proposal.sourceReferenceId, 'source-a');
    assert.equal(resolved.proposal.targetReferenceId, 'target-b');
    assert.equal(resolved.proposal.candidateKey, 'stale-candidate');
    assert.equal(resolved.proposal.confidence, 0.73);
});

test('resolves a repeated review idempotently after the proposal leaves the queue', () => {
    const existingReview = {
        sourceReferenceId: 'source-a',
        targetReferenceId: 'target-b',
        candidateKey: 'already-reviewed',
        decision: 'confirmed',
        citation: { displayCitation: 'Jones, B. (2020). Creative Agency.' }
    };
    const resolved = resolveCitationReviewProposal({
        sourceReferenceId: 'source-a',
        targetReferenceId: 'target-b',
        candidateKey: 'already-reviewed',
        graph: { ambiguousMatches: [] },
        scans: [],
        reviews: [existingReview]
    });
    assert.equal(resolved.proposalStateAtReview, 'existing_review');
    assert.equal(resolved.proposal, existingReview);
    assert.equal(resolved.existingReview, existingReview);
});
