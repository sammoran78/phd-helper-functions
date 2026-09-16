const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOpenAiTemperatureOptions } = require('../shared/openaiOptions');

test('blank configuration omits temperature rather than sending zero or one', () => {
    for (const value of ['', '   ', '\n\t', null]) {
        assert.deepEqual(buildOpenAiTemperatureOptions(value), {});
    }
});

test('explicit overrides preserve zero and parse numeric settings', () => {
    for (const [value, expected] of [['0', 0], ['0.3', 0.3], [' 1 ', 1], ['2', 2]]) {
        assert.deepEqual(buildOpenAiTemperatureOptions(value), { temperature: expected });
    }
});

test('invalid configuration fails clearly', () => {
    for (const value of ['NaN', 'Infinity', '-1', '2.1', '0.3garbage']) {
        assert.throws(() => buildOpenAiTemperatureOptions(value), /OPENAI_TEMPERATURE/);
    }
});

test('RAG payload uses the environment override and omits it when unset', () => {
    const { __test: { buildRagPayload } } = require('../src/functions/ai');
    const original = process.env.OPENAI_TEMPERATURE;
    const input = { model: 'future-model', vectorStoreId: 'vs-test', systemPrompt: '', historyText: '', query: 'Summarise' };
    try {
        delete process.env.OPENAI_TEMPERATURE;
        assert.deepEqual(buildOpenAiTemperatureOptions(), {});
        assert.equal(Object.hasOwn(buildRagPayload(input), 'temperature'), false);
        process.env.OPENAI_TEMPERATURE = '0';
        assert.equal(buildRagPayload(input).temperature, 0);
        process.env.OPENAI_TEMPERATURE = '0.3';
        assert.equal(buildRagPayload(input).temperature, 0.3);
        process.env.OPENAI_TEMPERATURE = '  ';
        assert.equal(Object.hasOwn(buildRagPayload(input), 'temperature'), false);
    } finally {
        if (original === undefined) delete process.env.OPENAI_TEMPERATURE;
        else process.env.OPENAI_TEMPERATURE = original;
    }
});
