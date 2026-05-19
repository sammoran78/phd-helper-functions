const { app } = require('@azure/functions');
const OpenAI = require('openai');
const { getItem, queryItems } = require('../../shared/cosmosClient');

const CONTAINER_PAGES = process.env.COSMOSDB_CONTAINER_PAGES || 'pages';
const CONTAINER_REFERENCES = process.env.COSMOSDB_CONTAINER_REFERENCES || 'references';
const CONTAINER_CHATS = process.env.COSMOSDB_CONTAINER_CHATS || 'chats';
const SYSTEM_PROMPT_DOC_ID = process.env.COSMOSDB_SYSTEM_PROMPT_ID || 'kb_system_prompt';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const SYSTEM_PROMPT_CACHE_MS = parsePositiveInt(process.env.KB_SYSTEM_PROMPT_CACHE_MS, 60000);
const KB_RAG_MAX_HISTORY_MESSAGES = parsePositiveInt(process.env.KB_RAG_MAX_HISTORY_MESSAGES, 6);
const KB_RAG_MAX_HISTORY_CHARS = parsePositiveInt(process.env.KB_RAG_MAX_HISTORY_CHARS, 6000);
const KB_RAG_MAX_USER_MESSAGE_CHARS = parsePositiveInt(process.env.KB_RAG_MAX_USER_MESSAGE_CHARS, 1800);
const KB_RAG_MAX_ASSISTANT_MESSAGE_CHARS = parsePositiveInt(process.env.KB_RAG_MAX_ASSISTANT_MESSAGE_CHARS, 1200);
const KB_RAG_MAX_QUERY_CHARS = parsePositiveInt(process.env.KB_RAG_MAX_QUERY_CHARS, 4000);
const KB_RAG_MAX_OUTPUT_TOKENS = parsePositiveInt(process.env.KB_RAG_MAX_OUTPUT_TOKENS, 3200);
const KB_RAG_DETAILED_OUTPUT_TOKENS = parsePositiveInt(process.env.KB_RAG_DETAILED_OUTPUT_TOKENS, 5200);
const KB_RAG_FILE_SEARCH_MAX_RESULTS = parsePositiveInt(process.env.KB_RAG_FILE_SEARCH_MAX_RESULTS, 8);
const KB_RAG_MAX_CITATIONS = parsePositiveInt(process.env.KB_RAG_MAX_CITATIONS, 8);
const KB_RAG_STREAM_HEARTBEAT_MS = parsePositiveInt(process.env.KB_RAG_STREAM_HEARTBEAT_MS, 15000);

let cachedSystemPrompt = {
    value: '',
    loadedAt: 0
};

function parsePositiveInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function withCorsHeaders(response) {
    return {
        ...response,
        headers: {
            ...(response?.headers || {}),
            'Access-Control-Allow-Origin': CORS_ORIGIN,
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
            'Access-Control-Max-Age': '86400'
        }
    };
}

function corsPreflightResponse() {
    return withCorsHeaders({
        status: 204,
        headers: {}
    });
}

function requiresDefaultTemperature(model) {
    const normalized = (model || '').toString().trim().toLowerCase();
    if (/^(o\d|o-)/.test(normalized)) return true;

    const match = normalized.match(/^gpt-(\d+)(?:\.(\d+))?/);
    if (!match) return false;

    const major = Number(match[1]);
    const minor = Number(match[2] || 0);
    return major > 5 || (major === 5 && minor >= 5);
}

function getChatCompletionContent(completion) {
    const message = completion?.choices?.[0]?.message;
    const content = message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(item => {
            if (typeof item === 'string') return item;
            if (typeof item?.text === 'string') return item.text;
            if (typeof item?.content === 'string') return item.content;
            return '';
        }).join('').trim();
    }
    return '';
}

// POST /api/ai/chat - Generic OpenAI chat completion
app.http('AIChat', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'ai/chat',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const { messages, max_tokens = 500, temperature = 0.7 } = body;
            
            if (!messages || !Array.isArray(messages) || messages.length === 0) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'messages array is required' })
                };
            }
            
            if (!process.env.OPENAI_API_KEY) {
                context.error('[AI Chat] OPENAI_API_KEY not set');
                return {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'OpenAI API key not configured' })
                };
            }
            
            const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
            const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
            const useDefaultTemperature = requiresDefaultTemperature(model);
            const completionTokenLimit = useDefaultTemperature ? Math.max(Number(max_tokens) || 500, 1500) : max_tokens;
            
            context.log(`[AI Chat] Calling OpenAI with ${messages.length} messages`);
            
            const completion = await openai.chat.completions.create({
                model: model,
                messages: messages,
                max_completion_tokens: completionTokenLimit,
                temperature: useDefaultTemperature ? 1 : temperature
            });
            
            const content = getChatCompletionContent(completion);
            
            context.log(`[AI Chat] Response received: ${content.length} chars; finish_reason=${completion.choices?.[0]?.finish_reason || 'unknown'}`);
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content: content,
                    choices: completion.choices,
                    usage: completion.usage
                })
            };
        } catch (error) {
            context.error('[AI Chat] Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'AI request failed', details: error.message })
            };
        }
    }
});

function getOutputText(response) {
    if (!response) return '';
    if (typeof response.output_text === 'string') return response.output_text;

    const output = Array.isArray(response.output) ? response.output : [];
    const messageItems = output.filter(item => item && item.type === 'message');
    const texts = [];
    for (const msg of messageItems) {
        const content = Array.isArray(msg.content) ? msg.content : [];
        for (const c of content) {
            if (c && typeof c.text === 'string') {
                texts.push(c.text);
            } else if (c && c.type === 'output_text' && typeof c.text === 'string') {
                texts.push(c.text);
            }
        }
    }
    return texts.join('\n').trim();
}

function truncateText(value, maxChars) {
    const text = (value || '').toString().trim();
    if (!text) return '';
    if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) return text;
    return `${text.slice(0, Math.max(maxChars - 1, 1)).trimEnd()}…`;
}

function collapseWhitespace(value) {
    return (value || '').toString().replace(/\s+/g, ' ').trim();
}

function stripCitationMarkers(value) {
    return (value || '')
        .toString()
        .replace(/\{\{cite:[^}]+\}\}/g, '')
        .replace(/[\u3010]\d+(?::\d+)?[\u2020\u2021][^\u3011]*[\u3011]/g, '')
        .trim();
}

function normalizeComparableText(value) {
    return collapseWhitespace(stripCitationMarkers(value)).toLowerCase();
}

function sanitizeHistoryMessage(message) {
    const role = (message?.role || 'user').toString().toLowerCase();
    const maxChars = role === 'assistant' ? KB_RAG_MAX_ASSISTANT_MESSAGE_CHARS : KB_RAG_MAX_USER_MESSAGE_CHARS;
    const content = truncateText(stripCitationMarkers(message?.content || ''), maxChars);
    return {
        role,
        content
    };
}

function buildConversationHistory(chat, currentQuery) {
    if (!chat || !Array.isArray(chat.messages) || chat.messages.length === 0) {
        return '';
    }

    const normalizedQuery = normalizeComparableText(currentQuery);
    const recent = chat.messages.slice(-KB_RAG_MAX_HISTORY_MESSAGES);
    const selected = [];
    let totalChars = 0;
    let skippedDuplicateCurrentQuery = false;

    for (let i = recent.length - 1; i >= 0; i -= 1) {
        const sanitized = sanitizeHistoryMessage(recent[i]);
        if (!sanitized.content) continue;

        if (!skippedDuplicateCurrentQuery && sanitized.role === 'user' && normalizedQuery && normalizeComparableText(sanitized.content) === normalizedQuery) {
            skippedDuplicateCurrentQuery = true;
            continue;
        }

        const line = `${sanitized.role.toUpperCase()}: ${sanitized.content}`;
        if (selected.length > 0 && (totalChars + line.length + 1) > KB_RAG_MAX_HISTORY_CHARS) {
            break;
        }

        selected.push(line);
        totalChars += line.length + 1;
    }

    return selected.reverse().join('\n');
}

function buildRagInstructions(systemPrompt) {
    return [
        '=== MANDATORY CITATION FORMAT ===',
        'EVERY claim you make that is supported by file_search results MUST include a citation marker in the EXACT form {{cite:FILE_ID}} immediately after the sentence.',
        'FILE_ID is the OpenAI file id (starts with "file-") from the file_search results.',
        'Example: "Photography transformed painting practices in the 1850s.{{cite:file-abc123}}"',
        '=== END MANDATORY FORMAT ===',
        '',
        systemPrompt,
        '',
        '--- LITERATURE REVIEW MODE ---',
        'You are a literature review assistant working over the user\'s academic corpus.',
        'Prefer synthesis over exhaustiveness: answer the exact question first, then compare positions, methods, or tensions only when they help.',
        'Keep the answer compact unless the user explicitly asks for a long treatment.',
        'Do not reveal chain-of-thought. Provide conclusions, evidence, and uncertainty directly.',
        'If the corpus does not support a claim, say so plainly instead of inferring beyond the sources.',
        '',
        '--- CITATION RULES (OVERRIDE ANY CONFLICTING INSTRUCTIONS ABOVE) ---',
        'Answer using ONLY the provided file_search results from the user\'s academic corpus.',
        'When you reference, quote, paraphrase, or summarise information from a source, you MUST append {{cite:FILE_ID}} immediately after the relevant sentence.',
        'ONLY use file IDs that appear in the file_search tool results. NEVER fabricate or guess a file ID.',
        'If you cannot find a supporting source in the file_search results, do NOT cite anything.',
        'IMPORTANT: Do NOT omit citation markers. Every referenced source MUST have at least one {{cite:FILE_ID}} marker.',
        '--- END CITATION RULES ---'
    ].filter(Boolean).join('\n');
}

function buildRagInput(query, historyText) {
    const trimmedQuery = truncateText((query || '').toString().trim(), KB_RAG_MAX_QUERY_CHARS);
    return [
        historyText ? `Recent conversation context:\n${historyText}` : '',
        `User question:\n${trimmedQuery}`
    ].filter(Boolean).join('\n\n');
}

function shouldUseDetailedOutputBudget(query) {
    const normalized = (query || '').toString().toLowerCase();
    if (!normalized) return false;

    return (
        normalized.length > 700
        || /(\bmore detail\b|\bdetailed\b|\bdetail(ed)? reasoning\b|\bstep[- ]by[- ]step\b|\bcompare\b|\bcontrast\b|\bliterature review\b|\bsurvey\b|\bstate of the art\b|\bhow to\b|\bplan\b|\binitiate\b|\bwhy\b|\bexplain\b)/.test(normalized)
    );
}

function getRagOutputTokenBudget(query) {
    return shouldUseDetailedOutputBudget(query)
        ? Math.max(KB_RAG_MAX_OUTPUT_TOKENS, KB_RAG_DETAILED_OUTPUT_TOKENS)
        : KB_RAG_MAX_OUTPUT_TOKENS;
}

function buildRagPayload({ model, vectorStoreId, systemPrompt, historyText, query }) {
    const maxOutputTokens = getRagOutputTokenBudget(query);
    return {
        model,
        instructions: buildRagInstructions(systemPrompt),
        input: buildRagInput(query, historyText),
        max_output_tokens: maxOutputTokens,
        tools: [
            {
                type: 'file_search',
                vector_store_ids: [vectorStoreId],
                max_num_results: KB_RAG_FILE_SEARCH_MAX_RESULTS
            }
        ],
        metadata: {
            rag_output_budget: String(maxOutputTokens),
            rag_profile: shouldUseDetailedOutputBudget(query) ? 'detailed' : 'standard'
        }
    };
}

function extractCitationIds(text) {
    const ids = [];
    if (!text || typeof text !== 'string') return ids;
    const re = /\{\{cite:([^}]+)\}\}/g;
    let match;
    while ((match = re.exec(text)) !== null) {
        const id = (match[1] || '').trim();
        if (id && !ids.includes(id)) ids.push(id);
    }
    return ids;
}

// Extract native file_citation annotations from an OpenAI Responses API response object
function extractNativeAnnotations(response) {
    const annotations = [];
    const output = Array.isArray(response?.output) ? response.output : [];
    for (const item of output) {
        if (item?.type !== 'message') continue;
        const content = Array.isArray(item.content) ? item.content : [];
        for (const c of content) {
            if (!Array.isArray(c?.annotations)) continue;
            for (const ann of c.annotations) {
                const fileId = ann?.file_id || ann?.file_citation?.file_id;
                if (fileId) {
                    annotations.push({
                        type: ann.type,
                        index: ann.index,
                        fileId,
                        filename: ann.filename || ann.file_citation?.filename || '',
                        startIndex: ann.start_index,
                        endIndex: ann.end_index
                    });
                }
            }
        }
    }
    return annotations;
}

// When the model uses OpenAI's native annotation markers (e.g. 【4:0†source】)
// instead of our {{cite:FILE_ID}} format, convert them.
// Also handles position-based injection when start/end indices are available.
function injectNativeAnnotationsAsCitations(text, annotations) {
    if (!text || !Array.isArray(annotations) || annotations.length === 0) return text;
    if (/\{\{cite:file-[^}]+\}\}/.test(text)) return text;

    let modified = text;

    // Build map of annotation index to file ID
    const indexToFileId = {};
    for (const ann of annotations) {
        if (ann.index != null && ann.fileId) {
            indexToFileId[ann.index] = ann.fileId;
        }
    }

    // Try replacing native annotation markers: 【n:m†label】 or 【n†label】
    const nativePattern = /[\u3010](\d+)(?::(\d+))?[\u2020\u2021]([^\u3011]*)[\u3011]/g;
    const beforeReplace = modified;
    modified = modified.replace(nativePattern, (match, idx) => {
        const annIndex = parseInt(idx, 10);
        const fileId = indexToFileId[annIndex];
        return fileId ? `{{cite:${fileId}}}` : match;
    });
    if (modified !== beforeReplace) return modified;

    // Fallback: position-based injection using start_index/end_index
    const sorted = [...annotations]
        .filter(a => a.startIndex != null && a.endIndex != null && a.fileId)
        .sort((a, b) => b.startIndex - a.startIndex);
    for (const ann of sorted) {
        const before = modified.slice(0, ann.endIndex);
        const after = modified.slice(ann.endIndex);
        modified = before + `{{cite:${ann.fileId}}}` + after;
    }

    // Final fallback: if still no markers, deduplicate file IDs and append them
    // at the end of the first paragraph that likely references the source
    if (!/\{\{cite:file-[^}]+\}\}/.test(modified)) {
        const uniqueFileIds = [];
        for (const ann of annotations) {
            if (ann.fileId && !uniqueFileIds.includes(ann.fileId)) {
                uniqueFileIds.push(ann.fileId);
            }
        }
        if (uniqueFileIds.length > 0) {
            const suffix = uniqueFileIds.map(fid => `{{cite:${fid}}}`).join('');
            const firstParaEnd = modified.indexOf('\n\n');
            if (firstParaEnd > 0) {
                modified = modified.slice(0, firstParaEnd) + suffix + modified.slice(firstParaEnd);
            } else {
                modified = modified + suffix;
            }
        }
    }

    return modified;
}

function normalizeCitationText(value) {
    return (value || '').toString().trim();
}

function isPlaceholderCitationValue(value) {
    const normalized = normalizeCitationText(value).toLowerCase();
    return (
        normalized === ''
        || normalized === 'unknown author'
        || normalized === 'unknown title'
        || normalized === 'untitled'
        || normalized === 'n.d.'
        || normalized === 'nd'
        || normalized === 'source unavailable'
    );
}

function getPrimaryAuthorSurname(authors) {
    const raw = normalizeCitationText(authors);
    if (!raw) return '';
    const firstAuthorChunk = raw.split(/\s+&\s+|\sand\s|;/i)[0].trim();
    if (!firstAuthorChunk) return '';
    if (firstAuthorChunk.includes(',')) {
        return firstAuthorChunk.split(',')[0].trim();
    }
    const words = firstAuthorChunk.split(/\s+/).filter(Boolean);
    return words.length > 0 ? words[words.length - 1] : '';
}

function isCitationResolved(citation) {
    return (
        !isPlaceholderCitationValue(citation?.authors)
        && !isPlaceholderCitationValue(citation?.year)
        && !isPlaceholderCitationValue(citation?.title)
    );
}

function buildCitationRecord(fileId, source = {}, options = {}) {
    const authors = normalizeCitationText(source?.authors || source?.author);
    const year = normalizeCitationText(source?.year);
    const title = normalizeCitationText(source?.title);
    const sourceLabel = normalizeCitationText(source?.source);
    const pageUrl = normalizeCitationText(source?.pageUrl || source?.blobUrl);

    const resolved = !isPlaceholderCitationValue(authors)
        && !isPlaceholderCitationValue(year)
        && !isPlaceholderCitationValue(title);

    const fallbackLabel = `[${fileId}]`;
    const shortText = resolved
        ? (() => {
            const surname = getPrimaryAuthorSurname(authors) || 'Source';
            return `(${surname}, ${year})`;
        })()
        : fallbackLabel;

    const apa7 = resolved
        ? (normalizeCitationText(source?.apa7) || buildApa7Fallback({ authors, year, title, source: sourceLabel }))
        : '';

    return {
        id: fileId,
        referenceId: source?.referenceId || null,
        pageNumber: source?.pageNumber != null ? String(source.pageNumber) : null,
        title: resolved ? title : '',
        authors: resolved ? authors : '',
        year: resolved ? year : '',
        pageUrl,
        blobUrl: pageUrl,
        apa7,
        resolved,
        shortText,
        resolutionStatus: options.resolutionStatus || (resolved ? 'resolved' : 'unresolved')
    };
}

function parseReferencePageFromVectorFileName(fileName) {
    const normalized = normalizeCitationText(fileName);
    if (!normalized) return null;
    const match = normalized.match(/^(ref_[^/]+)_page_(-?\d+)\.txt$/i);
    if (!match) return null;
    const pageNumber = Number.parseInt(match[2], 10);
    if (!Number.isFinite(pageNumber)) return null;
    return {
        referenceId: match[1],
        pageNumber
    };
}

async function resolveCitationFromOpenAiFileRecord(fileId, options = {}) {
    const openai = options?.openai;
    const context = options?.context;
    if (!openai || !fileId) return null;

    try {
        const fileRecord = await openai.files.retrieve(fileId);
        const parsed = parseReferencePageFromVectorFileName(fileRecord?.filename || fileRecord?.name);
        if (!parsed) return null;

        const pages = await queryItems(CONTAINER_PAGES, {
            query: 'SELECT TOP 1 * FROM c WHERE c.referenceId = @referenceId AND c.pageNumber = @pageNumber',
            parameters: [
                { name: '@referenceId', value: parsed.referenceId },
                { name: '@pageNumber', value: parsed.pageNumber }
            ]
        });

        const page = Array.isArray(pages) && pages.length > 0 ? pages[0] : null;
        const reference = parsed.referenceId ? await getItem(CONTAINER_REFERENCES, parsed.referenceId, parsed.referenceId) : null;

        if (!page && !reference) return null;

        return buildCitationRecord(fileId, {
            referenceId: parsed.referenceId || null,
            pageNumber: page?.pageNumber != null ? page.pageNumber : parsed.pageNumber,
            title: reference?.title || page?.metadata?.title,
            authors: reference?.authors || reference?.author || page?.metadata?.authors,
            year: reference?.year || page?.metadata?.year,
            source: reference?.source || page?.metadata?.source,
            pageUrl: page?.blobUrl,
            apa7: reference?.apa7
        }, {
            resolutionStatus: 'resolved_from_openai_file_lookup'
        });
    } catch (error) {
        context?.warn?.(`[KB RAG] OpenAI file lookup failed for ${fileId}:`, error?.message || String(error));
        return null;
    }
}

function buildApa7Fallback(reference) {
    const authors = reference?.authors || reference?.author || 'Unknown Author';
    const year = reference?.year || 'n.d.';
    const title = reference?.title || 'Untitled';
    const source = reference?.source || '';
    let citation = `${authors} (${year}). ${title}.`;
    if (source) citation += ` ${source}.`;
    return citation;
}

async function getSystemPrompt(context) {
    if (!SYSTEM_PROMPT_DOC_ID) return '';
    if (cachedSystemPrompt.loadedAt > 0 && (Date.now() - cachedSystemPrompt.loadedAt) < SYSTEM_PROMPT_CACHE_MS) {
        return cachedSystemPrompt.value;
    }
    try {
        let doc = await getItem(CONTAINER_CHATS, SYSTEM_PROMPT_DOC_ID, SYSTEM_PROMPT_DOC_ID);
        if (!doc) {
            const matches = await queryItems(CONTAINER_CHATS, {
                query: 'SELECT TOP 1 * FROM c WHERE c.id = @id',
                parameters: [{ name: '@id', value: SYSTEM_PROMPT_DOC_ID }]
            });
            doc = Array.isArray(matches) ? matches[0] : null;
        }
        const raw = doc?.content ?? doc?.systemPrompt ?? doc?.prompt ?? '';
        const resolved = (raw || '').toString().replace(/\\n/g, '\n').replace(/\\r/g, '\r').trim();
        cachedSystemPrompt = {
            value: resolved,
            loadedAt: Date.now()
        };
        return resolved;
    } catch (err) {
        if (context?.warn) {
            context.warn('[KB RAG] Failed to load system prompt', err?.message || String(err));
        }
        return '';
    }
}

async function lookupCitationByFileId(fileId, options = {}) {
    if (!fileId) return null;

    const pages = await queryItems(CONTAINER_PAGES, {
        query: 'SELECT TOP 1 * FROM c WHERE IS_DEFINED(c.openaiVector) AND c.openaiVector.fileId = @fileId',
        parameters: [{ name: '@fileId', value: fileId }]
    });
    const page = Array.isArray(pages) && pages.length > 0 ? pages[0] : null;
    if (!page) {
        const openAiResolved = await resolveCitationFromOpenAiFileRecord(fileId, options);
        if (openAiResolved) return openAiResolved;
        return buildCitationRecord(fileId, {}, { resolutionStatus: 'page_not_found' });
    }

    const referenceId = page.referenceId;
    let reference = referenceId ? await getItem(CONTAINER_REFERENCES, referenceId, referenceId) : null;

    let candidate = buildCitationRecord(fileId, {
        referenceId: referenceId || null,
        pageNumber: page.pageNumber,
        title: reference?.title || page?.metadata?.title,
        authors: reference?.authors || reference?.author || page?.metadata?.authors,
        year: reference?.year || page?.metadata?.year,
        source: reference?.source || page?.metadata?.source,
        pageUrl: page.blobUrl,
        apa7: reference?.apa7
    }, {
        resolutionStatus: 'reference_lookup'
    });

    if (candidate.resolved) return candidate;

    const pageBlobUrl = normalizeCitationText(page?.blobUrl);
    if (!reference && pageBlobUrl) {
        const byBlob = await queryItems(CONTAINER_REFERENCES, {
            query: 'SELECT TOP 1 * FROM c WHERE IS_DEFINED(c.files) AND ARRAY_CONTAINS(c.files, {"url": @blobUrl}, true)',
            parameters: [{ name: '@blobUrl', value: pageBlobUrl }]
        });
        if (Array.isArray(byBlob) && byBlob.length > 0) {
            reference = byBlob[0];
        }
    }

    candidate = buildCitationRecord(fileId, {
        referenceId: reference?.id || referenceId || null,
        pageNumber: page.pageNumber,
        title: reference?.title || page?.metadata?.title,
        authors: reference?.authors || reference?.author || page?.metadata?.authors,
        year: reference?.year || page?.metadata?.year,
        source: reference?.source || page?.metadata?.source,
        pageUrl: page.blobUrl,
        apa7: reference?.apa7
    }, {
        resolutionStatus: reference ? 'resolved_from_blob_lookup' : 'metadata_incomplete'
    });

    return candidate;
}

async function resolveCitationsForContent(content, context) {
    const options = arguments[2] || {};
    const citationIds = extractCitationIds(content);
    const citations = (await Promise.all(citationIds.slice(0, KB_RAG_MAX_CITATIONS).map(async (fileId) => {
        try {
            return await lookupCitationByFileId(fileId, { ...options, context });
        } catch (error) {
            context?.warn?.(`[KB RAG] Citation resolution failed for ${fileId}:`, error?.message || String(error));
            return buildCitationRecord(fileId, {}, { resolutionStatus: 'resolution_error' });
        }
    }))).filter(Boolean);

    return {
        citations,
        unresolvedCitationIds: citations.filter(c => !isCitationResolved(c)).map(c => c.id)
    };
}

app.http('KBRagChat', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'kb/rag-chat',
    handler: async (request, context) => {
        try {
            if (request.method === 'OPTIONS') return corsPreflightResponse();

            const requestStartedAt = Date.now();
            const body = await request.json();
            const query = (body?.query || body?.message || '').toString().trim();
            const chatId = (body?.chatId || '').toString().trim();
            const useReasoning = Boolean(body?.reasoning);
            const reasoningEffort = (process.env.OPENAI_REASONING_EFFORT || '').toString().trim();
            const systemPrompt = await getSystemPrompt(context);

            if (!query) {
                return withCorsHeaders({
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'query is required' })
                });
            }

            if (!process.env.OPENAI_API_KEY) {
                return withCorsHeaders({
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'OpenAI API key not configured' })
                });
            }

            const vectorStoreId = process.env.OPENAI_VECTOR_STORE;
            if (!vectorStoreId) {
                return withCorsHeaders({
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'OPENAI_VECTOR_STORE environment variable not configured' })
                });
            }

            const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
            const model = (process.env.OPENAI_MODEL || '').toString().trim();
            if (!model) {
                return withCorsHeaders({
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'OPENAI_MODEL environment variable not configured' })
                });
            }

            let historyText = '';
            if (chatId) {
                const chat = await getItem(CONTAINER_CHATS, chatId, chatId);
                historyText = buildConversationHistory(chat, query);
            }

            const basePayload = buildRagPayload({ model, vectorStoreId, systemPrompt, historyText, query });
            context.log('[KB RAG Chat] Prepared request', {
                chatId: chatId || null,
                useReasoning,
                historyChars: historyText.length,
                queryChars: query.length,
                maxOutputTokens: basePayload.max_output_tokens,
                ragProfile: basePayload.metadata?.rag_profile || 'standard',
                maxFileSearchResults: KB_RAG_FILE_SEARCH_MAX_RESULTS
            });

            let response;
            try {
                response = await openai.responses.create({
                    ...basePayload,
                    include: ['file_search_call.results'],
                    ...(useReasoning && reasoningEffort ? { reasoning_effort: reasoningEffort } : {})
                });
            } catch (err) {
                const msg = (err && err.message) ? err.message : String(err);
                if (useReasoning && reasoningEffort) {
                    context.warn('[KB RAG Chat] reasoning_effort rejected; retrying without it. Error:', msg);
                    try {
                        response = await openai.responses.create({
                            ...basePayload,
                            include: ['file_search_call.results']
                        });
                    } catch (retryErr) {
                        response = await openai.responses.create(basePayload);
                    }
                } else {
                    response = await openai.responses.create(basePayload);
                }
            }

            let content = getOutputText(response);

            // Fallback: if the model didn't produce {{cite:...}} markers,
            // extract native OpenAI file_search annotations and inject them
            if (!extractCitationIds(content).length) {
                const nativeAnnotations = extractNativeAnnotations(response);
                if (nativeAnnotations.length > 0) {
                    context.log(`[KB RAG Chat] No custom citation markers found; injecting ${nativeAnnotations.length} native annotation(s)`);
                    content = injectNativeAnnotationsAsCitations(content, nativeAnnotations);
                }
            }

            const { citations, unresolvedCitationIds } = await resolveCitationsForContent(content, context, { openai });
            context.log('[KB RAG Chat] Completed', {
                elapsedMs: Date.now() - requestStartedAt,
                outputChars: content.length,
                citations: citations.length,
                unresolvedCitationIds: unresolvedCitationIds.length
            });

            return withCorsHeaders({
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content,
                    citations,
                    unresolvedCitationIds,
                    vectorStoreId: vectorStoreId
                })
            });
        } catch (error) {
            context.error('[KB RAG Chat] Error:', error);
            return withCorsHeaders({
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'KB RAG request failed', details: error.message })
            });
        }
    }
});

app.http('KBRagChatStream', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'kb/rag-chat/stream',
    handler: async (request, context) => {
        try {
            if (request.method === 'OPTIONS') return corsPreflightResponse();

            const requestStartedAt = Date.now();
            const body = await request.json();
            const query = (body?.query || body?.message || '').toString().trim();
            const chatId = (body?.chatId || '').toString().trim();
            const useReasoning = Boolean(body?.reasoning);
            const reasoningEffort = (process.env.OPENAI_REASONING_EFFORT || '').toString().trim();
            const systemPrompt = await getSystemPrompt(context);

            if (!query) {
                return withCorsHeaders({
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'query is required' })
                });
            }

            if (!process.env.OPENAI_API_KEY) {
                return withCorsHeaders({
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'OpenAI API key not configured' })
                });
            }

            const vectorStoreId = process.env.OPENAI_VECTOR_STORE;
            if (!vectorStoreId) {
                return withCorsHeaders({
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'OPENAI_VECTOR_STORE environment variable not configured' })
                });
            }

            const model = (process.env.OPENAI_MODEL || '').toString().trim();
            if (!model) {
                return withCorsHeaders({
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'OPENAI_MODEL environment variable not configured' })
                });
            }

            const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

            let historyText = '';
            if (chatId) {
                const chat = await getItem(CONTAINER_CHATS, chatId, chatId);
                historyText = buildConversationHistory(chat, query);
            }

            const basePayload = buildRagPayload({ model, vectorStoreId, systemPrompt, historyText, query });
            context.log('[KB RAG Stream] Prepared request', {
                chatId: chatId || null,
                useReasoning,
                historyChars: historyText.length,
                queryChars: query.length,
                maxOutputTokens: basePayload.max_output_tokens,
                ragProfile: basePayload.metadata?.rag_profile || 'standard',
                maxFileSearchResults: KB_RAG_FILE_SEARCH_MAX_RESULTS
            });

            const { ReadableStream } = require('stream/web');
            const encoder = new TextEncoder();

            const stream = new ReadableStream({
                start(controller) {
                    const send = (eventName, data) => {
                        if (eventName) {
                            controller.enqueue(encoder.encode(`event: ${eventName}\n`));
                        }
                        const payload = typeof data === 'string' ? data : JSON.stringify(data);
                        const lines = payload.split(/\r?\n/);
                        for (const line of lines) {
                            controller.enqueue(encoder.encode(`data: ${line}\n`));
                        }
                        controller.enqueue(encoder.encode(`\n`));
                    };

                    send('ready', {
                        status: 'connected',
                        at: new Date().toISOString()
                    });

                    const heartbeatId = setInterval(() => {
                        send('ping', { at: new Date().toISOString() });
                    }, KB_RAG_STREAM_HEARTBEAT_MS);

                    (async () => {
                        let fullText = '';
                        let completedResponse = null;
                        let firstDeltaAt = 0;
                        let streamDeliveredText = false;
                        try {
                            let openaiStream;
                            try {
                                openaiStream = await openai.responses.create({
                                    ...basePayload,
                                    include: ['file_search_call.results'],
                                    stream: true,
                                    ...(useReasoning && reasoningEffort ? { reasoning_effort: reasoningEffort } : {})
                                });
                            } catch (err) {
                                const msg = (err && err.message) ? err.message : String(err);
                                if (useReasoning && reasoningEffort) {
                                    context.warn('[KB RAG Stream] reasoning_effort rejected; retrying without it. Error:', msg);
                                    openaiStream = await openai.responses.create({ ...basePayload, stream: true });
                                } else {
                                    throw err;
                                }
                            }

                            for await (const event of openaiStream) {
                                if (event?.type === 'response.output_text.delta' && typeof event?.delta === 'string') {
                                    if (!firstDeltaAt) {
                                        firstDeltaAt = Date.now();
                                        context.log('[KB RAG Stream] First delta received', {
                                            firstDeltaMs: firstDeltaAt - requestStartedAt
                                        });
                                    }
                                    fullText += event.delta;
                                    streamDeliveredText = true;
                                    send('delta', event.delta);
                                }
                                if (event?.type === 'response.completed' && event?.response) {
                                    completedResponse = event.response;
                                }
                            }

                            // Fallback: if the model didn't produce {{cite:...}} markers,
                            // extract native OpenAI file_search annotations and inject them
                            if (!extractCitationIds(fullText).length && completedResponse) {
                                const nativeAnnotations = extractNativeAnnotations(completedResponse);
                                if (nativeAnnotations.length > 0) {
                                    context.log(`[KB RAG Stream] No custom citation markers found; injecting ${nativeAnnotations.length} native annotation(s)`);
                                    fullText = injectNativeAnnotationsAsCitations(fullText, nativeAnnotations);
                                }
                            }

                            let citations = [];
                            let unresolvedCitationIds = [];
                            try {
                                const resolved = await resolveCitationsForContent(fullText, context, { openai });
                                citations = Array.isArray(resolved?.citations) ? resolved.citations : [];
                                unresolvedCitationIds = Array.isArray(resolved?.unresolvedCitationIds) ? resolved.unresolvedCitationIds : [];
                            } catch (citationError) {
                                context.warn('[KB RAG Stream] Citation resolution failed after content generation; returning content without hydrated citations.', {
                                    error: citationError?.message || String(citationError),
                                    outputChars: fullText.length
                                });
                            }

                            send('done', { content: fullText, citations, unresolvedCitationIds });
                            context.log('[KB RAG Stream] Completed', {
                                elapsedMs: Date.now() - requestStartedAt,
                                firstDeltaMs: firstDeltaAt ? (firstDeltaAt - requestStartedAt) : null,
                                outputChars: fullText.length,
                                citations: citations.length,
                                unresolvedCitationIds: unresolvedCitationIds.length
                            });
                            controller.close();
                        } catch (err) {
                            if (streamDeliveredText && fullText.trim()) {
                                context.warn('[KB RAG Stream] Stream failed after partial content; returning partial response instead of hard error.', {
                                    error: err?.message || String(err),
                                    outputChars: fullText.length
                                });
                                send('done', {
                                    content: fullText,
                                    citations: [],
                                    unresolvedCitationIds: [],
                                    partial: true,
                                    warning: err?.message || String(err)
                                });
                            } else {
                                send('error', { error: 'KB RAG stream failed', details: err?.message || String(err) });
                            }
                            controller.close();
                        } finally {
                            clearInterval(heartbeatId);
                        }
                    })();
                }
            });

            return withCorsHeaders({
                status: 200,
                enableContentNegotiation: false,
                headers: {
                    'Content-Type': 'text/event-stream; charset=utf-8',
                    'Cache-Control': 'no-cache, no-transform',
                    'Connection': 'keep-alive'
                },
                body: stream
            });
        } catch (error) {
            context.error('[KB RAG Chat Stream] Error:', error);
            return withCorsHeaders({
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'KB RAG stream setup failed', details: error.message })
            });
        }
    }
});
