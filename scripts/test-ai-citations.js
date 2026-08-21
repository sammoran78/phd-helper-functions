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
    assert.equal(payload.input[0].role, 'developer');
    assert.equal(payload.input[1].role, 'user');
    assert.match(payload.prompt_cache_key, /^phd-rag-v2-/);
    assert.equal(payload.instructions, undefined);

    const explicitCachePayload = __test.buildRagPayload({
        model: 'gpt-5.6-terra',
        vectorStoreId: 'vs-test',
        systemPrompt: 'Stable research profile',
        historyText: 'USER: Earlier context',
        query: 'Current question'
    });
    const secondExplicitCachePayload = __test.buildRagPayload({
        model: 'gpt-5.6-terra',
        vectorStoreId: 'vs-test',
        systemPrompt: 'Stable research profile',
        historyText: 'USER: Different context',
        query: 'Different question'
    });
    assert.deepEqual(explicitCachePayload.prompt_cache_options, { mode: 'explicit', ttl: '30m' });
    assert.deepEqual(explicitCachePayload.input[0].content[0].prompt_cache_breakpoint, { mode: 'explicit' });
    assert.equal(explicitCachePayload.prompt_cache_key, secondExplicitCachePayload.prompt_cache_key);
    assert.notEqual(explicitCachePayload.input[1].content[0].text, secondExplicitCachePayload.input[1].content[0].text);
    assert.equal(explicitCachePayload.metadata.prompt_cache_profile, 'explicit-30m');

    const extendedCachePayload = __test.buildRagPayload({
        model: 'gpt-5.4',
        vectorStoreId: 'vs-test',
        systemPrompt: 'Stable research profile',
        historyText: '',
        query: 'Current question'
    });
    assert.equal(extendedCachePayload.prompt_cache_retention, '24h');
    assert.equal(extendedCachePayload.prompt_cache_options, undefined);
    assert.equal(extendedCachePayload.input[0].content[0].prompt_cache_breakpoint, undefined);

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
