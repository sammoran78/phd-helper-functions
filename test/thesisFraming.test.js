const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
    DEFAULT_THESIS_FRAMING,
    buildAuthoritativeSystemPrompt,
    buildResearchSearchPrompt,
    buildThesisFramingText,
    framingVersion,
    normalizeThesisFraming
} = require('../shared/thesisFraming');
const { verifyDashboardConfigEditor } = require('../shared/requestAuth');

const base64Url = value => Buffer.from(value).toString('base64url');
const requestForEmail = (email, secret) => {
    const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = base64Url(JSON.stringify({ email, exp: Math.floor(Date.now() / 1000) + 60 }));
    const signature = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
    return { headers: { get: name => name.toLowerCase() === 'authorization' ? `Bearer ${header}.${payload}.${signature}` : null } };
};

test('default framing contains the current RQ and three current sub-questions', () => {
    assert.match(DEFAULT_THESIS_FRAMING.researchQuestion, /retain agency/i);
    assert.deepEqual(DEFAULT_THESIS_FRAMING.subQuestions.map(question => question.id), ['SQ1', 'SQ2', 'SQ3']);
    assert.match(DEFAULT_THESIS_FRAMING.subQuestions[0].question, /technological disruption/i);
    assert.match(DEFAULT_THESIS_FRAMING.subQuestions[1].question, /directed engineering effort/i);
    assert.match(DEFAULT_THESIS_FRAMING.subQuestions[2].question, /returned to creative workers/i);
});

test('RAG framing excludes discovery priorities while search framing includes them', () => {
    const framing = normalizeThesisFraming({
        ...DEFAULT_THESIS_FRAMING,
        discoveryPriorities: 'Prioritise longitudinal studies.'
    });
    const ragText = buildThesisFramingText(framing);
    const searchText = buildResearchSearchPrompt(framing);

    assert.doesNotMatch(ragText, /longitudinal studies/i);
    assert.match(searchText, /Discovery priorities: Prioritise longitudinal studies/i);
    assert.match(searchText, /SQ2 \(Technical\)/);
});

test('RAG system prompt receives an explicit authoritative framing override', () => {
    const prompt = buildAuthoritativeSystemPrompt(
        'Original prompt text with an obsolete RQ.',
        DEFAULT_THESIS_FRAMING
    );
    assert.match(prompt, /^Original prompt text/m);
    assert.match(prompt, /AUTHORITATIVE THESIS FRAMING/);
    assert.match(prompt, /whenever earlier prompt text differs/);
    assert.match(prompt, /SQ3 \(Policy\/governance\)/);
});

test('framing version changes when an SQ changes and ignores metadata', () => {
    const original = framingVersion(DEFAULT_THESIS_FRAMING);
    const metadataOnly = framingVersion({ ...DEFAULT_THESIS_FRAMING, updatedAt: '2026-08-23T00:00:00Z' });
    const changed = framingVersion({
        ...DEFAULT_THESIS_FRAMING,
        subQuestions: DEFAULT_THESIS_FRAMING.subQuestions.map((question, index) =>
            index === 0 ? { ...question, question: `${question.question} Updated.` } : question
        )
    });

    assert.equal(metadataOnly, original);
    assert.notEqual(changed, original);
});

test('only configured editors may update shared framing', () => {
    const oldSecret = process.env.AUTH_JWT_SECRET;
    const oldEditors = process.env.DASHBOARD_CONFIG_EDITOR_EMAILS;
    process.env.AUTH_JWT_SECRET = 'test-only-framing-secret';
    process.env.DASHBOARD_CONFIG_EDITOR_EMAILS = 'editor@example.test';
    try {
        assert.ok(verifyDashboardConfigEditor(requestForEmail('EDITOR@example.test', process.env.AUTH_JWT_SECRET)));
        assert.equal(verifyDashboardConfigEditor(requestForEmail('reader@example.test', process.env.AUTH_JWT_SECRET)), null);
    } finally {
        if (oldSecret === undefined) delete process.env.AUTH_JWT_SECRET;
        else process.env.AUTH_JWT_SECRET = oldSecret;
        if (oldEditors === undefined) delete process.env.DASHBOARD_CONFIG_EDITOR_EMAILS;
        else process.env.DASHBOARD_CONFIG_EDITOR_EMAILS = oldEditors;
    }
});
