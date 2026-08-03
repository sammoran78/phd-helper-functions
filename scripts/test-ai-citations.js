const assert = require('node:assert/strict');
const { __test } = require('../src/functions/ai');

async function run() {
    const payload = __test.buildRagPayload({
        model: 'gpt-test',
        vectorStoreId: 'vs-test',
        systemPrompt: '',
        historyText: '',
        query: 'Summarise the evidence'
    });
    assert.deepEqual(payload.include, ['file_search_call.results']);

    const fromSearchResult = __test.buildCitationRecordFromFileSearchResult('file-test', {
        file_name: 'ref_example_page_00003.txt',
        file_attributes: {
            REFERENCE_ID: 'ref_example',
            page_number: '3',
            TITLE: 'Creative Labour and AI',
            Author: 'Jane Scholar',
            YEAR: '2025'
        }
    });
    assert.equal(fromSearchResult.resolved, true);
    assert.equal(fromSearchResult.referenceId, 'ref_example');
    assert.equal(fromSearchResult.pageNumber, '3');
    assert.equal(fromSearchResult.shortText, '(Scholar, 2025)');

    const fromDocumentHeader = __test.buildCitationRecordFromFileSearchResult('file-header', {
        text: [
            '[DOC_METADATA]',
            'reference_id: ref_header',
            'page-number: 7',
            'title: Platform Work',
            'authors: Alex Writer',
            'year: 2024',
            '[/DOC_METADATA]'
        ].join('\n')
    });
    assert.equal(fromDocumentHeader.resolved, true);
    assert.equal(fromDocumentHeader.referenceId, 'ref_header');
    assert.equal(fromDocumentHeader.pageNumber, '7');
    assert.equal(fromDocumentHeader.shortText, '(Writer, 2024)');

    const openai = {
        vectorStores: {
            files: {
                retrieve: async (vectorStoreId, fileId) => {
                    assert.equal(vectorStoreId, 'vs-test');
                    assert.equal(fileId, 'file-vector');
                    return {
                        attributes: {
                            referenceId: 'ref_vector',
                            pageNumber: '11',
                            title: 'Recovered Reference',
                            authors: 'Robin Researcher',
                            year: '2026'
                        }
                    };
                }
            }
        },
        files: {
            retrieve: async () => ({ filename: 'ref_vector_page_00011.txt' })
        }
    };
    const fromVectorStore = await __test.resolveCitationFromVectorStoreFile('file-vector', {
        openai,
        vectorStoreId: 'vs-test'
    });
    assert.equal(fromVectorStore.resolved, true);
    assert.equal(fromVectorStore.shortText, '(Researcher, 2026)');
    assert.equal(fromVectorStore.resolutionStatus, 'resolved_from_vector_store_metadata');

    console.log('AI citation mapping tests passed');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
