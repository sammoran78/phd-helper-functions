const test = require('node:test');
const assert = require('node:assert/strict');
const {
    normalizeChatProvider,
    buildOpenAiReasoningOptions,
    buildAnthropicReasoningOptions,
    normalizeVectorSearchResults,
    buildFileSearchResultMap,
    buildAnthropicRagInput,
    extractAnthropicText,
    getAnthropicTextDelta
} = require('../shared/ragProviders');

test('model provider defaults to OpenAI and only accepts supported values', () => {
    assert.equal(normalizeChatProvider(), 'openai');
    assert.equal(normalizeChatProvider('OpenAI'), 'openai');
    assert.equal(normalizeChatProvider('ANTHROPIC'), 'anthropic');
    assert.equal(normalizeChatProvider('fable'), null);
});

test('provider reasoning options use each API request shape', () => {
    assert.deepEqual(buildOpenAiReasoningOptions(true, 'HIGH'), { reasoning: { effort: 'high' } });
    assert.deepEqual(buildOpenAiReasoningOptions(false, 'high'), {});
    assert.deepEqual(buildAnthropicReasoningOptions(true, 'MEDIUM'), {
        thinking: { type: 'adaptive', display: 'omitted' },
        output_config: { effort: 'medium' }
    });
    assert.deepEqual(buildAnthropicReasoningOptions(false, 'medium'), {});
});

test('OpenAI retrieval results become bounded Anthropic context with file IDs', () => {
    const results = normalizeVectorSearchResults({
        data: [
            { file_id: 'file-one', content: [{ type: 'text', text: 'First excerpt' }] },
            { file_id: 'file-two', content: [{ type: 'text', text: 'Second excerpt' }] }
        ]
    });
    const map = buildFileSearchResultMap(results);
    const input = buildAnthropicRagInput({
        query: 'What do the papers say?',
        historyText: 'USER: Earlier question',
        searchResults: results,
        maxContextChars: 100
    });

    assert.equal(map.size, 2);
    assert.match(input, /<source file_id="file-one">/);
    assert.match(input, /First excerpt/);
    assert.match(input, /Recent conversation context:/);
    assert.match(input, /What do the papers say\?/);
});

test('Anthropic text helpers omit thinking blocks', () => {
    assert.equal(extractAnthropicText({
        content: [
            { type: 'thinking', thinking: 'hidden reasoning' },
            { type: 'text', text: 'Visible answer' }
        ]
    }), 'Visible answer');
    assert.equal(getAnthropicTextDelta({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Visible' }
    }), 'Visible');
    assert.equal(getAnthropicTextDelta({
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'hidden' }
    }), '');
});
