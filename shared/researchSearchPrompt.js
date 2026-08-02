const { getItem, upsertItem } = require('./cosmosClient');

const ANALYTICS_CONTAINER = process.env.COSMOSDB_CONTAINER_ANALYTICS || 'analytics';
const RESEARCH_SEARCH_PROMPT_ID = 'research_search_prompt';
const MAX_RESEARCH_SEARCH_PROMPT_LENGTH = 4000;
const DEFAULT_RESEARCH_SEARCH_PROMPT = `This PhD examines how generative artificial intelligence is reshaping creative labour and creative practice across the cultural and creative industries. It focuses on creative workers' lived experience, agency and authorship; the tactics people use to steer, constrain and co-create with AI; whether those tactics transfer across music, screen, design, writing, interactive work and career stages; and how findings can translate into teaching resources, industry guidance and policy for sustainable creative practice. It also considers attribution, provenance, consent, copyright, licensing, royalties and compensation. Prioritise high-quality, internationally relevant empirical and theoretical scholarship, while treating local case studies as useful only when they materially illuminate this framing.`;

const normalizeContent = (content) => (content ?? '').toString().trim();

const getResearchSearchPrompt = async () => {
    let document = await getItem(
        ANALYTICS_CONTAINER,
        RESEARCH_SEARCH_PROMPT_ID,
        RESEARCH_SEARCH_PROMPT_ID
    );

    if (!document) {
        const now = new Date().toISOString();
        document = await upsertItem(ANALYTICS_CONTAINER, {
            id: RESEARCH_SEARCH_PROMPT_ID,
            type: 'research_search_prompt',
            content: DEFAULT_RESEARCH_SEARCH_PROMPT,
            createdAt: now,
            updatedAt: now
        });
    }

    return {
        ...document,
        id: RESEARCH_SEARCH_PROMPT_ID,
        content: normalizeContent(document.content) || DEFAULT_RESEARCH_SEARCH_PROMPT
    };
};

const saveResearchSearchPrompt = async (content) => {
    const normalized = normalizeContent(content);
    if (!normalized) {
        const error = new Error('Research search prompt cannot be empty');
        error.status = 400;
        throw error;
    }
    if (normalized.length > MAX_RESEARCH_SEARCH_PROMPT_LENGTH) {
        const error = new Error(`Research search prompt cannot exceed ${MAX_RESEARCH_SEARCH_PROMPT_LENGTH} characters`);
        error.status = 400;
        throw error;
    }

    const existing = await getItem(
        ANALYTICS_CONTAINER,
        RESEARCH_SEARCH_PROMPT_ID,
        RESEARCH_SEARCH_PROMPT_ID
    );
    const now = new Date().toISOString();

    return upsertItem(ANALYTICS_CONTAINER, {
        ...(existing || {}),
        id: RESEARCH_SEARCH_PROMPT_ID,
        type: 'research_search_prompt',
        content: normalized,
        createdAt: existing?.createdAt || now,
        updatedAt: now
    });
};

module.exports = {
    DEFAULT_RESEARCH_SEARCH_PROMPT,
    MAX_RESEARCH_SEARCH_PROMPT_LENGTH,
    RESEARCH_SEARCH_PROMPT_ID,
    getResearchSearchPrompt,
    saveResearchSearchPrompt
};
