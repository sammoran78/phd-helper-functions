const {
    buildResearchSearchPrompt,
    getThesisFraming,
    saveThesisFraming
} = require('./thesisFraming');

const RESEARCH_SEARCH_PROMPT_ID = 'research_search_prompt';
const MAX_RESEARCH_SEARCH_PROMPT_LENGTH = 5000;

const getResearchSearchPrompt = async () => {
    const framing = await getThesisFraming();
    return {
        id: RESEARCH_SEARCH_PROMPT_ID,
        type: 'derived_research_search_prompt',
        content: buildResearchSearchPrompt(framing),
        editableContent: framing.discoveryPriorities || '',
        updatedAt: framing.updatedAt,
        framingVersion: framing.version,
        subQuestions: framing.subQuestions,
        derivedFrom: framing.id
    };
};

const saveResearchSearchPrompt = async (content) => {
    const normalized = (content ?? '').toString().trim();
    if (!normalized) {
        const error = new Error('Discovery priorities cannot be empty');
        error.status = 400;
        throw error;
    }
    if (normalized.length > MAX_RESEARCH_SEARCH_PROMPT_LENGTH) {
        const error = new Error(`Discovery priorities cannot exceed ${MAX_RESEARCH_SEARCH_PROMPT_LENGTH} characters`);
        error.status = 400;
        throw error;
    }
    const framing = await saveThesisFraming({ discoveryPriorities: normalized });
    return {
        id: RESEARCH_SEARCH_PROMPT_ID,
        type: 'derived_research_search_prompt',
        content: buildResearchSearchPrompt(framing),
        editableContent: framing.discoveryPriorities,
        updatedAt: framing.updatedAt,
        framingVersion: framing.version,
        subQuestions: framing.subQuestions,
        derivedFrom: framing.id
    };
};

module.exports = {
    MAX_RESEARCH_SEARCH_PROMPT_LENGTH,
    RESEARCH_SEARCH_PROMPT_ID,
    getResearchSearchPrompt,
    saveResearchSearchPrompt
};
