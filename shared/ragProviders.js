const Anthropic = require('@anthropic-ai/sdk');

const CHAT_PROVIDERS = Object.freeze({
    OPENAI: 'openai',
    ANTHROPIC: 'anthropic'
});

function normalizeChatProvider(value) {
    const normalized = (value || '').toString().trim().toLowerCase();
    if (!normalized) return CHAT_PROVIDERS.OPENAI;
    if (normalized === CHAT_PROVIDERS.OPENAI || normalized === CHAT_PROVIDERS.ANTHROPIC) {
        return normalized;
    }
    return null;
}

function buildOpenAiReasoningOptions(useReasoning, effort) {
    const normalizedEffort = (effort || '').toString().trim().toLowerCase();
    if (!useReasoning || !normalizedEffort) return {};
    return { reasoning: { effort: normalizedEffort } };
}

function buildAnthropicReasoningOptions(useReasoning, effort) {
    if (!useReasoning) return {};
    const normalizedEffort = (effort || '').toString().trim().toLowerCase();
    return {
        thinking: { type: 'adaptive', display: 'omitted' },
        ...(normalizedEffort ? { output_config: { effort: normalizedEffort } } : {})
    };
}

function getVectorSearchResultText(result = {}) {
    if (typeof result.text === 'string') return result.text.trim();
    if (typeof result.snippet === 'string') return result.snippet.trim();
    if (!Array.isArray(result.content)) return '';
    return result.content
        .map(block => {
            if (typeof block === 'string') return block;
            if (typeof block?.text === 'string') return block.text;
            return '';
        })
        .filter(Boolean)
        .join('\n')
        .trim();
}

function normalizeVectorSearchResults(searchResponse) {
    const data = Array.isArray(searchResponse?.data) ? searchResponse.data : [];
    return data.map(result => ({
        ...result,
        text: getVectorSearchResultText(result)
    }));
}

function buildFileSearchResultMap(results = []) {
    const map = new Map();
    for (const result of results) {
        const fileId = result?.file_id || result?.fileId || result?.file?.id;
        if (fileId && !map.has(fileId)) map.set(fileId, result);
    }
    return map;
}

function buildAnthropicRagInput({ query, historyText, searchResults, maxContextChars = 24000 }) {
    const excerpts = [];
    let usedChars = 0;

    for (const result of Array.isArray(searchResults) ? searchResults : []) {
        const fileId = result?.file_id || result?.fileId || result?.file?.id;
        const text = getVectorSearchResultText(result);
        if (!fileId || !text) continue;

        const remaining = Math.max(maxContextChars - usedChars, 0);
        if (remaining <= 0) break;
        const excerpt = text.length > remaining ? `${text.slice(0, Math.max(remaining - 1, 1)).trimEnd()}…` : text;
        excerpts.push(`<source file_id="${fileId}">\n${excerpt}\n</source>`);
        usedChars += excerpt.length;
    }

    return [
        'Retrieved corpus excerpts:',
        excerpts.length ? excerpts.join('\n\n') : 'No matching corpus excerpts were found.',
        historyText ? `Recent conversation context:\n${historyText}` : '',
        `User question:\n${(query || '').toString().trim()}`
    ].filter(Boolean).join('\n\n');
}

function createAnthropicClient(apiKey) {
    return new Anthropic({ apiKey });
}

function extractAnthropicText(message) {
    const content = Array.isArray(message?.content) ? message.content : [];
    return content
        .filter(block => block?.type === 'text' && typeof block?.text === 'string')
        .map(block => block.text)
        .join('\n')
        .trim();
}

function getAnthropicTextDelta(event) {
    if (event?.type !== 'content_block_delta') return '';
    return event?.delta?.type === 'text_delta' && typeof event?.delta?.text === 'string'
        ? event.delta.text
        : '';
}

module.exports = {
    CHAT_PROVIDERS,
    normalizeChatProvider,
    buildOpenAiReasoningOptions,
    buildAnthropicReasoningOptions,
    normalizeVectorSearchResults,
    buildFileSearchResultMap,
    buildAnthropicRagInput,
    createAnthropicClient,
    extractAnthropicText,
    getAnthropicTextDelta
};
