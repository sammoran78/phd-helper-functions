const test = require('node:test');
const assert = require('node:assert/strict');

const {
    aggregateCitationGraph,
    extractReferenceEntries,
    normalizeDoi,
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

test('creates a directed corpus edge and retains overlooked works with evidence', () => {
    const result = scanReferenceCitations(references[0], pages, references);
    assert.deepEqual(result.edges.map(edge => [edge.sourceReferenceId, edge.targetReferenceId]), [['source-a', 'target-b']]);
    assert.equal(result.edges[0].matchType, 'doi');
    assert.match(result.edges[0].evidence[0].excerpt, /Creative Agency/);
    assert.equal(result.missingWorks.length, 1);
    assert.equal(result.missingWorks[0].title, 'Overlooked Creative Labour');
});

test('aggregates inbound/outbound degree and shared missing citations', () => {
    const scanA = {
        sourceReferenceId: 'source-a',
        edges: [{ sourceReferenceId: 'source-a', targetReferenceId: 'target-b', confidence: 1, matchType: 'doi' }],
        missingWorks: [{ canonicalKey: 'brown|2019|overlooked creative labour', title: 'Overlooked Creative Labour', authors: 'Brown, C.', year: 2019, occurrenceCount: 1 }]
    };
    const scanC = {
        sourceReferenceId: 'source-c',
        edges: [],
        missingWorks: [{ canonicalKey: 'brown|2019|overlooked creative labour', title: 'Overlooked Creative Labour', authors: 'Brown, C.', year: 2019, occurrenceCount: 1 }]
    };
    const graph = aggregateCitationGraph(references, [scanA, scanC]);
    assert.equal(graph.edges.length, 1);
    assert.equal(graph.nodes.find(node => node.id === 'source-a').outbound, 1);
    assert.equal(graph.nodes.find(node => node.id === 'target-b').inbound, 1);
    assert.deepEqual(graph.missingWorks[0].citedBySourceIds.sort(), ['source-a', 'source-c']);
});

test('reconciles a formerly missing work when it is later added to the corpus', () => {
    const scan = {
        sourceReferenceId: 'source-a',
        edges: [],
        missingWorks: [{
            canonicalKey: 'doi:10.1234/agency.2020',
            doi: '10.1234/agency.2020',
            title: 'Creative Agency and Artificial Intelligence',
            occurrenceCount: 1
        }]
    };
    const graph = aggregateCitationGraph(references, [scan]);
    assert.equal(graph.missingWorks.length, 0);
    assert.equal(graph.edges[0].targetReferenceId, 'target-b');
    assert.match(graph.edges[0].matchType, /^reconciled_/);
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
