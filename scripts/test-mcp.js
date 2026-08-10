const assert = require('assert/strict');
const {
    CURRENT_PROTOCOL_VERSION,
    TOOL_NAME,
    createMcpHandler,
    formatAnswerForMcp
} = require('../src/functions/mcp');

function makeRequest(body, options = {}) {
    const method = options.method || 'POST';
    const headers = new Headers(options.headers || {});
    return {
        method,
        url: 'https://functions.example.test/api/mcp',
        headers,
        json: async () => body
    };
}

function currentBody(id, method, params = {}) {
    return {
        jsonrpc: '2.0',
        id,
        method,
        params: {
            ...params,
            _meta: {
                'io.modelcontextprotocol/protocolVersion': CURRENT_PROTOCOL_VERSION,
                'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
                'io.modelcontextprotocol/clientCapabilities': {}
            }
        }
    };
}

function currentHeaders(method, name) {
    return {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': CURRENT_PROTOCOL_VERSION,
        'Mcp-Method': method,
        ...(name ? { 'Mcp-Name': name } : {})
    };
}

function parse(response) {
    return response.body ? JSON.parse(response.body) : null;
}

async function run() {
    process.env.MCP_RAG_ALLOW_UNAUTHENTICATED = 'true';
    const context = { error() {} };
    const handler = createMcpHandler({
        dependencies: {
            authorize: async () => ({ ok: true, principal: { sub: 'test' } }),
            queryCorpus: async () => ({
                content: 'Agency is negotiated.{{cite:file-1}}',
                markdown: 'Agency is negotiated.[(Moran, 2026)](<https://example.test/page.pdf>)\n\n## Sources\n\n- Moran, S. (2026). Example.',
                citations: [{
                    id: 'file-1',
                    shortText: '(Moran, 2026)',
                    title: 'Example',
                    apa7: 'Moran, S. (2026). Example.',
                    pageUrl: 'https://example.test/page.pdf'
                }],
                unresolvedCitationIds: [],
                partial: false
            }),
            loadResearchProfile: async () => '# Research profile'
        }
    });

    const discoverMethod = 'server/discover';
    const discoverResponse = await handler(
        makeRequest(currentBody(1, discoverMethod), { headers: currentHeaders(discoverMethod) }),
        context
    );
    const discover = parse(discoverResponse);
    assert.equal(discoverResponse.status, 200);
    assert.equal(discover.result.resultType, 'complete');
    assert.ok(discover.result.supportedVersions.includes(CURRENT_PROTOCOL_VERSION));
    assert.equal(discover.result._meta['io.modelcontextprotocol/serverInfo'].name, 'phd-rag');
    assert.equal(discover.result.ttlMs, 300000);
    assert.equal(discover.result.cacheScope, 'public');

    const listMethod = 'tools/list';
    const listResponse = await handler(
        makeRequest(currentBody(2, listMethod), { headers: currentHeaders(listMethod) }),
        context
    );
    const listed = parse(listResponse);
    assert.equal(listed.result.resultType, 'complete');
    assert.equal(listed.result.tools[0].name, TOOL_NAME);
    assert.equal(listed.result.tools[0].annotations.readOnlyHint, true);

    const callMethod = 'tools/call';
    const callResponse = await handler(
        makeRequest(currentBody(3, callMethod, {
            name: TOOL_NAME,
            arguments: { query: 'How is agency negotiated?', detail: 'detailed' }
        }), { headers: currentHeaders(callMethod, TOOL_NAME) }),
        context
    );
    const called = parse(callResponse);
    assert.equal(called.result.resultType, 'complete');
    assert.equal(called.result._meta['io.modelcontextprotocol/serverInfo'].name, 'phd-rag');
    assert.equal(called.result.isError, false);
    assert.match(called.result.content[0].text, /Moran, 2026/);
    assert.equal(called.result.structuredContent.citations.length, 1);
    assert.equal(called.result.content[1].type, 'resource_link');

    const legacyInitialize = await handler(makeRequest({
        jsonrpc: '2.0',
        id: 4,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'legacy', version: '1' } }
    }, { headers: { Accept: 'application/json, text/event-stream' } }), context);
    const initialized = parse(legacyInitialize);
    assert.equal(initialized.result.protocolVersion, '2025-06-18');

    const badHeaders = currentHeaders(listMethod);
    delete badHeaders['Mcp-Method'];
    const invalidResponse = await handler(
        makeRequest(currentBody(5, listMethod), { headers: badHeaders }),
        context
    );
    assert.equal(invalidResponse.status, 400);
    assert.equal(parse(invalidResponse).error.code, -32020);

    const noClientInfoBody = currentBody(7, listMethod);
    delete noClientInfoBody.params._meta['io.modelcontextprotocol/clientInfo'];
    const noClientInfoResponse = await handler(
        makeRequest(noClientInfoBody, { headers: currentHeaders(listMethod) }),
        context
    );
    assert.equal(noClientInfoResponse.status, 200);

    const currentInitializeResponse = await handler(
        makeRequest(currentBody(8, 'initialize'), { headers: currentHeaders('initialize') }),
        context
    );
    assert.equal(currentInitializeResponse.status, 404);
    assert.equal(parse(currentInitializeResponse).error.code, -32601);

    const formatted = formatAnswerForMcp('A claim.{{cite:file-1}}', [{
        id: 'file-1',
        shortText: '(Author, 2024)',
        apa7: 'Author, A. (2024). Title.',
        pageUrl: 'https://example.test/page.pdf'
    }]);
    assert.match(formatted, /\[\(Author, 2024\)\]/);
    assert.match(formatted, /## Sources/);
    assert.doesNotMatch(formatted, /file-1/);

    process.env.MCP_RAG_ALLOW_UNAUTHENTICATED = 'false';
    const authHandler = createMcpHandler({
        dependencies: {
            authorize: async () => ({ ok: false, reason: 'No bearer access token was provided' })
        }
    });
    const authListResponse = await authHandler(
        makeRequest(currentBody(6, listMethod), { headers: currentHeaders(listMethod) }),
        context
    );
    assert.equal(authListResponse.status, 401);
    assert.match(authListResponse.headers['WWW-Authenticate'], /^Bearer /);

    const authResponse = await authHandler(
        makeRequest(currentBody(9, callMethod, {
            name: TOOL_NAME,
            arguments: { query: 'test' }
        }), { headers: currentHeaders(callMethod, TOOL_NAME) }),
        context
    );
    const authResult = parse(authResponse).result;
    assert.equal(authResponse.status, 401);
    assert.equal(authResult, undefined);
    assert.match(authResponse.headers['WWW-Authenticate'], /^Bearer /);

    console.log('MCP protocol tests passed');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
