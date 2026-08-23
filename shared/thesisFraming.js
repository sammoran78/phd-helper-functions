const crypto = require('crypto');
const { getItem, upsertItem } = require('./cosmosClient');

const ANALYTICS_CONTAINER = process.env.COSMOSDB_CONTAINER_ANALYTICS || 'analytics';
const THESIS_FRAMING_ID = 'thesis_framing';
const MAX_FIELD_LENGTH = 5000;
const MAX_SUB_QUESTIONS = 8;

const DEFAULT_THESIS_FRAMING = Object.freeze({
    projectTitle: 'Creative Agency in the Age of Gen-AI',
    projectAim: "To develop a practice-led, industry-validated framework that supports creative workers' agency, authorship, attribution and professional sustainability when co-creating with generative AI.",
    researchQuestion: 'How can creative workers retain agency over whether and how they engage with generative-AI systems built from their work?',
    subQuestions: [
        {
            id: 'SQ1',
            title: 'Creative labour, agency and technological disruption',
            lens: 'Sociocultural',
            question: 'How do creative workers perceive and engage with generative AI, and what do historical responses to technological disruption reveal about the conditions under which creative labour retains agency?',
            keywords: ['creative workers', 'creative labour', 'agency', 'technological disruption', 'lived experience', 'sociocultural', 'history']
        },
        {
            id: 'SQ2',
            title: 'Attribution and directed engineering effort',
            lens: 'Technical',
            question: 'How do generative AI systems currently attribute the works on which they are trained, and how responsive is that attribution to directed engineering effort?',
            keywords: ['attribution', 'training data', 'provenance', 'metadata', 'watermarking', 'engineering effort', 'technical evaluation']
        },
        {
            id: 'SQ3',
            title: 'Responsibility, regulation and returned value',
            lens: 'Policy/governance',
            question: 'On what normative basis, and under what regulatory frameworks, can the costs of improving attribution be shifted to system builders and the recovered value returned to creative workers?',
            keywords: ['normative basis', 'regulation', 'governance', 'system builders', 'cost shifting', 'licensing', 'royalties', 'compensation', 'creator value']
        }
    ],
    discoveryPriorities: 'Prioritise high-quality, internationally relevant empirical and theoretical scholarship. Include current and historical technological disruption of creative industries, technical attribution research, and normative or regulatory work on provenance, licensing, compensation and returning value to creative workers.'
});

const normalizeText = (value, fallback = '') => {
    const text = (value ?? fallback).toString().trim();
    return text.slice(0, MAX_FIELD_LENGTH);
};

const normalizeKeywords = (value) => {
    const list = Array.isArray(value) ? value : normalizeText(value).split(/[,;\n]/);
    return Array.from(new Set(list
        .map(keyword => normalizeText(keyword).toLowerCase())
        .filter(Boolean)))
        .slice(0, 30);
};

const normalizeSubQuestions = (value) => {
    const source = Array.isArray(value) && value.length ? value : DEFAULT_THESIS_FRAMING.subQuestions;
    return source.slice(0, MAX_SUB_QUESTIONS).map((item, index) => {
        const fallback = DEFAULT_THESIS_FRAMING.subQuestions[index] || {};
        return {
            id: normalizeText(item?.id, `SQ${index + 1}`).toUpperCase().replace(/[^A-Z0-9_-]/g, '') || `SQ${index + 1}`,
            title: normalizeText(item?.title, fallback.title || `Sub-question ${index + 1}`),
            lens: normalizeText(item?.lens, fallback.lens || ''),
            question: normalizeText(item?.question, fallback.question || ''),
            keywords: normalizeKeywords(item?.keywords?.length ? item.keywords : fallback.keywords)
        };
    }).filter(item => item.question);
};

const normalizeThesisFraming = (input = {}, existing = {}) => ({
    projectTitle: normalizeText(input.projectTitle, existing.projectTitle || DEFAULT_THESIS_FRAMING.projectTitle),
    projectAim: normalizeText(input.projectAim, existing.projectAim || DEFAULT_THESIS_FRAMING.projectAim),
    researchQuestion: normalizeText(input.researchQuestion, existing.researchQuestion || DEFAULT_THESIS_FRAMING.researchQuestion),
    subQuestions: normalizeSubQuestions(input.subQuestions || existing.subQuestions),
    discoveryPriorities: normalizeText(input.discoveryPriorities, existing.discoveryPriorities || DEFAULT_THESIS_FRAMING.discoveryPriorities)
});

const framingVersion = (framing) => crypto
    .createHash('sha256')
    .update(JSON.stringify(normalizeThesisFraming(framing)))
    .digest('hex')
    .slice(0, 16);

const buildThesisFramingText = (framing) => {
    const normalized = normalizeThesisFraming(framing);
    const subQuestions = normalized.subQuestions
        .map(item => `${item.id}${item.lens ? ` (${item.lens})` : ''}: ${item.question}`)
        .join('\n');
    return [
        `Project: ${normalized.projectTitle}`,
        `Aim: ${normalized.projectAim}`,
        `Research question: ${normalized.researchQuestion}`,
        'Sub-questions:',
        subQuestions
    ].join('\n');
};

const buildResearchSearchPrompt = (framing) => {
    const normalized = normalizeThesisFraming(framing);
    return `${buildThesisFramingText(normalized)}\nDiscovery priorities: ${normalized.discoveryPriorities}`.trim();
};

const buildAuthoritativeSystemPrompt = (basePrompt, framing) => [
    (basePrompt ?? '').toString().trim(),
    '## AUTHORITATIVE THESIS FRAMING (managed separately)\nUse this aim and these question identifiers whenever earlier prompt text differs.\n' + buildThesisFramingText(framing)
].filter(Boolean).join('\n\n');

const withMetadata = (framing, metadata = {}) => {
    const normalized = normalizeThesisFraming(framing);
    return {
        id: THESIS_FRAMING_ID,
        type: 'thesis_framing',
        ...normalized,
        version: framingVersion(normalized),
        ...metadata
    };
};

const getThesisFraming = async () => {
    let document = await getItem(ANALYTICS_CONTAINER, THESIS_FRAMING_ID, THESIS_FRAMING_ID);
    if (!document) {
        const now = new Date().toISOString();
        document = await upsertItem(ANALYTICS_CONTAINER, withMetadata(DEFAULT_THESIS_FRAMING, {
            createdAt: now,
            updatedAt: now
        }));
    }
    return withMetadata(document, {
        createdAt: document.createdAt,
        updatedAt: document.updatedAt
    });
};

const saveThesisFraming = async (input = {}) => {
    const existing = await getItem(ANALYTICS_CONTAINER, THESIS_FRAMING_ID, THESIS_FRAMING_ID);
    const now = new Date().toISOString();
    const normalized = normalizeThesisFraming(input, existing || DEFAULT_THESIS_FRAMING);
    if (!normalized.projectAim || !normalized.researchQuestion || normalized.subQuestions.length === 0) {
        const error = new Error('Project aim, research question, and at least one sub-question are required');
        error.status = 400;
        throw error;
    }
    return upsertItem(ANALYTICS_CONTAINER, withMetadata(normalized, {
        createdAt: existing?.createdAt || now,
        updatedAt: now
    }));
};

module.exports = {
    DEFAULT_THESIS_FRAMING,
    MAX_SUB_QUESTIONS,
    THESIS_FRAMING_ID,
    buildAuthoritativeSystemPrompt,
    buildResearchSearchPrompt,
    buildThesisFramingText,
    framingVersion,
    getThesisFraming,
    normalizeThesisFraming,
    saveThesisFraming
};
