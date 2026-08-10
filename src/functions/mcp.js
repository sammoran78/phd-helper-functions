const { app } = require('@azure/functions');
const crypto = require('crypto');

const CURRENT_PROTOCOL_VERSION = '2026-07-28';
const LEGACY_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'];
const SUPPORTED_PROTOCOL_VERSIONS = [CURRENT_PROTOCOL_VERSION, ...LEGACY_PROTOCOL_VERSIONS];
const RESOURCE_URI = 'phd-rag://research-profile';
const TOOL_NAME = 'query_phd_knowledge_base';
const PROMPT_NAME = 'research_with_phd_corpus';
const DEFAULT_SCOPE = 'rag.read';
const SERVER_INFO = {
    name: 'phd-rag',
    title: 'Creative Agency and GenAI PhD Knowledge Base',
    version: '1.0.0'
};
const SERVER_INSTRUCTIONS = [
    `Use ${TOOL_NAME} whenever a question could benefit from Sam Moran's private PhD corpus on creative agency and generative AI.`,
    'The tool is read-only and stateless, returns citation-ready Markdown plus structured APA7 citation metadata, and does not modify browser chat history.',
    'Treat corpus evidence as primary; state clearly when the corpus does not support a claim.'
].join(' ');

const jwksCache = { value: null, expiresAt: 0 };
const rateLimitBuckets = new Map();

function envFlag(name, fallback = false) {
    const value = process.env[name];
    if (value == null || value === '') return fallback;
    return /^(1|true|yes|on)$/i.test(value.toString().trim());
}

function parsePositiveInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getHeader(request, name) {
    return request?.headers?.get?.(name) || request?.headers?.[name] || request?.headers?.[name.toLowerCase()] || '';
}

function getRequestOrigin(request) {
    try {
        return new URL(request.url).origin;
    } catch {
        return '';
    }
}

function getCanonicalMcpUrl(request) {
    return (process.env.MCP_CANONICAL_URL || `${getRequestOrigin(request)}/api/mcp`).replace(/\/$/, '');
}

function getResourceMetadataUrl(request) {
    return process.env.MCP_OAUTH_RESOURCE_METADATA_URL
        || `${getRequestOrigin(request)}/api/.well-known/oauth-protected-resource`;
}

function getAllowedOrigins(request) {
    const configured = (process.env.MCP_ALLOWED_ORIGINS || '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);
    const sameOrigin = getRequestOrigin(request);
    if (sameOrigin) configured.push(sameOrigin);
    return new Set(configured);
}

function isOriginAllowed(request) {
    const origin = getHeader(request, 'origin').trim();
    if (!origin) return true;
    return getAllowedOrigins(request).has(origin);
}

function corsHeaders(request) {
    const origin = getHeader(request, 'origin').trim();
    return {
        'Access-Control-Allow-Origin': origin && isOriginAllowed(request) ? origin : '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name',
        'Access-Control-Expose-Headers': 'WWW-Authenticate, MCP-Protocol-Version',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin'
    };
}

function jsonResponse(request, status, payload, headers = {}) {
    return {
        status,
        headers: {
            ...corsHeaders(request),
            'Content-Type': 'application/json; charset=utf-8',
            ...headers
        },
        body: payload == null ? undefined : JSON.stringify(payload)
    };
}

function rpcResult(id, result) {
    return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message, data) {
    return {
        jsonrpc: '2.0',
        id: id ?? null,
        error: {
            code,
            message,
            ...(data === undefined ? {} : { data })
        }
    };
}

function withResultType(result, mode) {
    if (mode !== 'current') return result;
    return {
        resultType: 'complete',
        ...result,
        _meta: {
            'io.modelcontextprotocol/serverInfo': SERVER_INFO,
            ...(result?._meta || {})
        }
    };
}

function decodeMcpHeaderValue(value) {
    const raw = (value || '').toString();
    const match = raw.match(/^=\?base64\?([A-Za-z0-9+/=]+)\?=$/);
    if (!match) return raw;
    try {
        return Buffer.from(match[1], 'base64').toString('utf8');
    } catch {
        return raw;
    }
}

function validateProtocolRequest(request, body) {
    const method = (body?.method || '').toString();
    const params = body?.params && typeof body.params === 'object' ? body.params : {};
    const meta = params._meta && typeof params._meta === 'object' ? params._meta : {};
    const headerVersion = getHeader(request, 'mcp-protocol-version').trim();
    const metaVersion = (meta['io.modelcontextprotocol/protocolVersion'] || '').toString().trim();
    const requestedVersion = headerVersion || metaVersion;

    if (requestedVersion && !SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)) {
        return {
            ok: false,
            status: 400,
            error: rpcError(body?.id, -32022, 'Unsupported protocol version', {
                supported: SUPPORTED_PROTOCOL_VERSIONS,
                requested: requestedVersion
            })
        };
    }

    const current = requestedVersion === CURRENT_PROTOCOL_VERSION || metaVersion === CURRENT_PROTOCOL_VERSION;
    if (!current) return { ok: true, mode: 'legacy', version: requestedVersion || '2025-03-26' };

    if (!headerVersion || !metaVersion || headerVersion !== metaVersion) {
        return {
            ok: false,
            status: 400,
            error: rpcError(body?.id, -32020, 'Header mismatch: MCP protocol version header and request metadata must both be present and match')
        };
    }

    const clientInfo = meta['io.modelcontextprotocol/clientInfo'];
    const clientCapabilities = meta['io.modelcontextprotocol/clientCapabilities'];
    const malformedClientInfo = clientInfo !== undefined
        && (!clientInfo || typeof clientInfo !== 'object' || !clientInfo.name || !clientInfo.version);
    if (malformedClientInfo || !clientCapabilities || typeof clientCapabilities !== 'object' || Array.isArray(clientCapabilities)) {
        return {
            ok: false,
            status: 400,
            error: rpcError(body?.id, -32602, 'Required clientCapabilities metadata is missing or per-request clientInfo is malformed')
        };
    }

    const accept = getHeader(request, 'accept').toLowerCase();
    if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
        return {
            ok: false,
            status: 400,
            error: rpcError(body?.id, -32602, 'Accept must include application/json and text/event-stream')
        };
    }

    const headerMethod = getHeader(request, 'mcp-method').trim();
    if (!headerMethod || headerMethod !== method) {
        return {
            ok: false,
            status: 400,
            error: rpcError(body?.id, -32020, 'Header mismatch: Mcp-Method does not match the JSON-RPC method')
        };
    }

    const nameMethods = new Set(['tools/call', 'resources/read', 'prompts/get']);
    if (nameMethods.has(method)) {
        const bodyName = (params.name || params.uri || '').toString();
        const headerName = decodeMcpHeaderValue(getHeader(request, 'mcp-name'));
        if (!headerName || headerName !== bodyName) {
            return {
                ok: false,
                status: 400,
                error: rpcError(body?.id, -32020, 'Header mismatch: Mcp-Name does not match the request name or URI')
            };
        }
    }

    return { ok: true, mode: 'current', version: CURRENT_PROTOCOL_VERSION };
}

function getSecuritySchemes() {
    if (envFlag('MCP_RAG_ALLOW_UNAUTHENTICATED')) return [{ type: 'noauth' }];
    if (process.env.MCP_OAUTH_ISSUER || process.env.MCP_OAUTH_AUTHORIZATION_SERVER) {
        return [{ type: 'oauth2', scopes: [process.env.MCP_OAUTH_SCOPE || DEFAULT_SCOPE] }];
    }
    return [];
}

function getToolDefinition() {
    const securitySchemes = getSecuritySchemes();
    return {
        name: TOOL_NAME,
        title: 'Query the PhD knowledge base',
        description: [
            "Search and synthesize Sam Moran's private academic corpus on creative agency and generative AI.",
            'Use this for literature review, source-grounded comparisons, theoretical or methodological analysis, evidence checks, and research-gap questions.',
            'Returns citation-ready Markdown and structured APA7 metadata. Read-only; does not search the public web or save chat history.'
        ].join(' '),
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                query: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 4000,
                    description: 'A focused research question for the PhD corpus.'
                },
                context: {
                    type: 'string',
                    maxLength: 3000,
                    description: 'Optional minimal context needed to disambiguate the question. Do not send the full conversation by default.'
                },
                detail: {
                    type: 'string',
                    enum: ['standard', 'detailed'],
                    default: 'standard',
                    description: 'Use detailed for literature reviews, comparisons, or multi-part synthesis.'
                }
            },
            required: ['query']
        },
        outputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                content: { type: 'string' },
                markdown: { type: 'string' },
                citations: { type: 'array', items: { type: 'object' } },
                unresolvedCitationIds: { type: 'array', items: { type: 'string' } },
                partial: { type: 'boolean' }
            },
            required: ['content', 'markdown', 'citations', 'unresolvedCitationIds', 'partial']
        },
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false
        },
        ...(securitySchemes.length ? { securitySchemes } : {})
    };
}

function getCapabilities() {
    return {
        tools: { listChanged: false },
        resources: { listChanged: false, subscribe: false },
        prompts: { listChanged: false }
    };
}

function timingSafeEqualText(left, right) {
    const leftBuffer = Buffer.from((left || '').toString());
    const rightBuffer = Buffer.from((right || '').toString());
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseJwt(token) {
    const parts = (token || '').split('.');
    if (parts.length !== 3) throw new Error('Access token is not a JWT');
    const decode = value => JSON.parse(Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return {
        header: decode(parts[0]),
        payload: decode(parts[1]),
        signingInput: `${parts[0]}.${parts[1]}`,
        signature: Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    };
}

async function getJwks(fetchImpl = fetch) {
    if (jwksCache.value && jwksCache.expiresAt > Date.now()) return jwksCache.value;
    let jwksUri = (process.env.MCP_OAUTH_JWKS_URI || '').trim();
    const issuer = (process.env.MCP_OAUTH_ISSUER || process.env.MCP_OAUTH_AUTHORIZATION_SERVER || '').replace(/\/$/, '');
    if (!jwksUri) {
        if (!issuer) throw new Error('MCP OAuth issuer is not configured');
        const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
        const discoveryResponse = await fetchImpl(discoveryUrl, { headers: { Accept: 'application/json' } });
        if (!discoveryResponse.ok) throw new Error(`OAuth discovery failed with HTTP ${discoveryResponse.status}`);
        const discovery = await discoveryResponse.json();
        jwksUri = discovery.jwks_uri;
    }
    if (!jwksUri) throw new Error('OAuth discovery did not provide jwks_uri');
    const response = await fetchImpl(jwksUri, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`JWKS fetch failed with HTTP ${response.status}`);
    const jwks = await response.json();
    if (!Array.isArray(jwks?.keys)) throw new Error('JWKS response has no keys array');
    jwksCache.value = jwks;
    jwksCache.expiresAt = Date.now() + parsePositiveInt(process.env.MCP_OAUTH_JWKS_CACHE_MS, 3600000);
    return jwks;
}

async function verifyOauthToken(token, request, fetchImpl = fetch) {
    const parsed = parseJwt(token);
    if (parsed.header.alg !== 'RS256') throw new Error('Only RS256 OAuth access tokens are supported');
    const jwks = await getJwks(fetchImpl);
    const jwk = jwks.keys.find(key => key.kid === parsed.header.kid && (!key.use || key.use === 'sig'));
    if (!jwk) throw new Error('No matching OAuth signing key found');
    const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const verified = crypto.verify('RSA-SHA256', Buffer.from(parsed.signingInput), publicKey, parsed.signature);
    if (!verified) throw new Error('OAuth access token signature is invalid');

    const now = Math.floor(Date.now() / 1000);
    const issuer = (process.env.MCP_OAUTH_ISSUER || process.env.MCP_OAUTH_AUTHORIZATION_SERVER || '').replace(/\/$/, '');
    const audience = process.env.MCP_OAUTH_AUDIENCE || getCanonicalMcpUrl(request);
    const tokenAudiences = Array.isArray(parsed.payload.aud) ? parsed.payload.aud : [parsed.payload.aud];
    if (issuer && parsed.payload.iss?.replace?.(/\/$/, '') !== issuer) throw new Error('OAuth issuer does not match');
    if (!tokenAudiences.includes(audience)) throw new Error('OAuth audience does not match this MCP server');
    if (!Number.isFinite(parsed.payload.exp) || parsed.payload.exp <= now) throw new Error('OAuth access token has expired');
    if (Number.isFinite(parsed.payload.nbf) && parsed.payload.nbf > now + 60) throw new Error('OAuth access token is not active yet');

    const requiredScope = process.env.MCP_OAUTH_SCOPE || DEFAULT_SCOPE;
    const scopes = new Set([
        ...((parsed.payload.scope || '').toString().split(/\s+/)),
        ...((parsed.payload.scp || '').toString().split(/\s+/))
    ].filter(Boolean));
    if (requiredScope && !scopes.has(requiredScope)) throw new Error(`OAuth token is missing ${requiredScope}`);
    return parsed.payload;
}

function getBearerToken(request) {
    const match = getHeader(request, 'authorization').match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : '';
}

async function authorizeRequest(request, fetchImpl = fetch) {
    if (envFlag('MCP_RAG_ALLOW_UNAUTHENTICATED')) return { ok: true, principal: { sub: 'anonymous' } };
    const token = getBearerToken(request);
    if (!token) return { ok: false, reason: 'No bearer access token was provided' };

    const staticToken = process.env.MCP_RAG_TOKEN || '';
    if (staticToken && timingSafeEqualText(token, staticToken)) {
        return { ok: true, principal: { sub: 'static-token' } };
    }

    if (process.env.MCP_OAUTH_ISSUER || process.env.MCP_OAUTH_AUTHORIZATION_SERVER) {
        try {
            return { ok: true, principal: await verifyOauthToken(token, request, fetchImpl) };
        } catch (error) {
            const insufficientScope = error.message.startsWith('OAuth token is missing ');
            return {
                ok: false,
                reason: error.message,
                status: insufficientScope ? 403 : 401,
                error: insufficientScope ? 'insufficient_scope' : 'invalid_token'
            };
        }
    }
    return { ok: false, reason: 'MCP authentication is not configured for this token' };
}

function buildAuthChallenge(request, reason = 'Authentication required', errorCode = 'invalid_token') {
    const safeReason = reason.replace(/["\\\r\n]/g, ' ').slice(0, 180);
    return `Bearer resource_metadata="${getResourceMetadataUrl(request)}", scope="${process.env.MCP_OAUTH_SCOPE || DEFAULT_SCOPE}", error="${errorCode}", error_description="${safeReason}"`;
}

function checkRateLimit(request) {
    const maxRequests = parsePositiveInt(process.env.MCP_RAG_RATE_LIMIT_REQUESTS, 30);
    const windowMs = parsePositiveInt(process.env.MCP_RAG_RATE_LIMIT_WINDOW_MS, 60000);
    const identity = getBearerToken(request) || getHeader(request, 'x-forwarded-for').split(',')[0].trim() || 'anonymous';
    const key = crypto.createHash('sha256').update(identity).digest('hex');
    const now = Date.now();
    const bucket = rateLimitBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
        rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs });
        return { ok: true };
    }
    bucket.count += 1;
    if (bucket.count <= maxRequests) return { ok: true };
    return { ok: false, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
}

function sanitizeArguments(argumentsValue) {
    const args = argumentsValue && typeof argumentsValue === 'object' && !Array.isArray(argumentsValue)
        ? argumentsValue
        : {};
    const query = (args.query || '').toString().trim();
    const context = (args.context || '').toString().trim();
    const detail = args.detail === 'detailed' ? 'detailed' : 'standard';
    if (!query) throw new Error('query is required');
    if (query.length > 4000) throw new Error('query must be 4000 characters or fewer');
    if (context.length > 3000) throw new Error('context must be 3000 characters or fewer');
    return { query, context, detail };
}

function buildEffectiveQuery(args) {
    const sections = [];
    if (args.context) sections.push(`Relevant context from the host conversation:\n${args.context}`);
    sections.push(`Research question:\n${args.query}`);
    if (args.detail === 'detailed') {
        sections.push('Provide a detailed, source-grounded comparison or synthesis with clear limitations and implications.');
    }
    return sections.join('\n\n').slice(0, 4000);
}

function getUpstreamBaseUrl(request) {
    return (process.env.MCP_RAG_UPSTREAM_BASE_URL || `${getRequestOrigin(request)}/api`).replace(/\/$/, '');
}

async function fetchUpstreamJson(request, path, options = {}, fetchImpl = fetch) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), parsePositiveInt(process.env.MCP_RAG_UPSTREAM_TIMEOUT_MS, 180000));
    try {
        const headers = {
            Accept: 'application/json',
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...(process.env.MCP_RAG_UPSTREAM_TOKEN ? { Authorization: `Bearer ${process.env.MCP_RAG_UPSTREAM_TOKEN}` } : {})
        };
        const response = await fetchImpl(`${getUpstreamBaseUrl(request)}${path}`, {
            method: options.method || 'GET',
            headers,
            body: options.body ? JSON.stringify(options.body) : undefined,
            signal: controller.signal
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload?.details || payload?.error || `Upstream RAG returned HTTP ${response.status}`);
        return payload;
    } finally {
        clearTimeout(timeout);
    }
}

function safeHttpUrl(value) {
    try {
        const url = new URL((value || '').toString());
        return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
    } catch {
        return '';
    }
}

function safeLinkLabel(value) {
    return (value || '').toString().replace(/[\[\]]/g, '').trim();
}

function formatAnswerForMcp(content, citations) {
    const citationList = Array.isArray(citations) ? citations : [];
    const citationMap = new Map(citationList.map(citation => [citation?.id, citation]));
    const markdown = (content || '').toString().replace(/\{\{cite:([^}]+)\}\}/g, (_match, rawId) => {
        const citation = citationMap.get((rawId || '').trim());
        if (!citation) return '';
        const label = safeLinkLabel(citation.shortText || '') || '(Source)';
        const url = safeHttpUrl(citation.pageUrl || citation.blobUrl);
        return url ? `[${label}](<${url}>)` : label;
    }).replace(/[ \t]+\n/g, '\n').trim();

    const sourceLines = [];
    const seen = new Set();
    for (const citation of citationList) {
        const apa7 = (citation?.apa7 || '').toString().trim();
        if (!apa7) continue;
        const key = citation.referenceId || apa7;
        if (seen.has(key)) continue;
        seen.add(key);
        const url = safeHttpUrl(citation.pageUrl || citation.blobUrl);
        sourceLines.push(`- ${apa7}${url ? ` [View source](<${url}>)` : ''}`);
    }
    return sourceLines.length ? `${markdown}\n\n## Sources\n\n${sourceLines.join('\n')}` : markdown;
}

async function queryCorpus(request, rawArguments, fetchImpl = fetch) {
    const args = sanitizeArguments(rawArguments);
    const payload = await fetchUpstreamJson(request, '/kb/rag-chat', {
        method: 'POST',
        body: {
            query: buildEffectiveQuery(args),
            reasoning: args.detail === 'detailed'
        }
    }, fetchImpl);
    const citations = Array.isArray(payload?.citations) ? payload.citations : [];
    const structuredContent = {
        content: (payload?.content || '').toString(),
        markdown: formatAnswerForMcp(payload?.content, citations),
        citations,
        unresolvedCitationIds: Array.isArray(payload?.unresolvedCitationIds) ? payload.unresolvedCitationIds : [],
        partial: Boolean(payload?.partial)
    };
    return structuredContent;
}

async function loadResearchProfile(request, fetchImpl = fetch) {
    const payload = await fetchUpstreamJson(request, '/kb/system-prompt', {}, fetchImpl);
    return (payload?.content || '').toString();
}

function toolError(message, mode, meta) {
    return withResultType({
        content: [{ type: 'text', text: message }],
        ...(meta ? { _meta: meta } : {}),
        isError: true
    }, mode);
}

function authToolError(request, authorization, mode) {
    const challenge = buildAuthChallenge(request, authorization.reason, authorization.error);
    return toolError(`Authentication required: ${authorization.reason}.`, mode, {
        'mcp/www_authenticate': [challenge]
    });
}

async function dispatchRpc({ request, context, body, mode, fetchImpl = fetch, dependencies = {} }) {
    const id = body.id;
    const method = body.method;
    const params = body.params || {};
    const authorize = dependencies.authorize || (req => authorizeRequest(req, fetchImpl));
    const runQuery = dependencies.queryCorpus || ((req, args) => queryCorpus(req, args, fetchImpl));
    const loadProfile = dependencies.loadResearchProfile || (req => loadResearchProfile(req, fetchImpl));

    if (method === 'server/discover') {
        return { status: 200, payload: rpcResult(id, withResultType({
            supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
            capabilities: getCapabilities(),
            instructions: SERVER_INSTRUCTIONS,
            ttlMs: 300000,
            cacheScope: 'public'
        }, mode)) };
    }

    if (method === 'initialize' && mode === 'legacy') {
        const requested = (params.protocolVersion || '').toString();
        const selected = LEGACY_PROTOCOL_VERSIONS.includes(requested) ? requested : LEGACY_PROTOCOL_VERSIONS[0];
        return { status: 200, payload: rpcResult(id, {
            protocolVersion: selected,
            capabilities: getCapabilities(),
            serverInfo: SERVER_INFO,
            instructions: SERVER_INSTRUCTIONS
        }) };
    }

    if (method === 'tools/list') {
        return { status: 200, payload: rpcResult(id, withResultType({
            tools: [getToolDefinition()],
            ttlMs: 300000,
            cacheScope: 'private'
        }, mode)) };
    }

    if (method === 'tools/call') {
        if (params.name !== TOOL_NAME) {
            return { status: 400, payload: rpcError(id, -32602, `Unknown tool: ${params.name || ''}`) };
        }
        const authorization = await authorize(request);
        if (!authorization.ok) {
            if (mode === 'current') {
                const challenge = buildAuthChallenge(request, authorization.reason, authorization.error);
                return {
                    status: authorization.status || 401,
                    headers: { 'WWW-Authenticate': challenge },
                    payload: rpcError(id, -32000, authorization.reason)
                };
            }
            return { status: 200, payload: rpcResult(id, authToolError(request, authorization, mode)) };
        }
        const rateLimit = checkRateLimit(request);
        if (!rateLimit.ok) {
            return { status: 200, payload: rpcResult(id, toolError(`Rate limit exceeded. Retry after ${rateLimit.retryAfter} seconds.`, mode)) };
        }
        try {
            const structuredContent = await runQuery(request, params.arguments || {});
            const links = structuredContent.citations
                .map(citation => ({ citation, url: safeHttpUrl(citation.pageUrl || citation.blobUrl) }))
                .filter(item => item.url)
                .slice(0, 12)
                .map(({ citation, url }, index) => ({
                    type: 'resource_link',
                    uri: url,
                    name: citation.shortText || `source-${index + 1}`,
                    title: citation.title || citation.apa7 || `Corpus source ${index + 1}`,
                    description: citation.apa7 || undefined,
                    mimeType: 'application/pdf'
                }));
            return { status: 200, payload: rpcResult(id, withResultType({
                content: [
                    { type: 'text', text: structuredContent.markdown },
                    ...links
                ],
                structuredContent,
                isError: false
            }, mode)) };
        } catch (error) {
            context?.error?.('[MCP] RAG tool failed', error);
            return { status: 200, payload: rpcResult(id, toolError(`The PhD knowledge base query failed: ${error.message}`, mode)) };
        }
    }

    if (method === 'resources/list') {
        return { status: 200, payload: rpcResult(id, withResultType({
            resources: [{
                uri: RESOURCE_URI,
                name: 'research-profile',
                title: 'PhD research profile and answer conventions',
                description: 'The live browser RAG system prompt, including research scope, theory, methodology, tone, and output preferences.',
                mimeType: 'text/markdown'
            }],
            ttlMs: 60000,
            cacheScope: 'private'
        }, mode)) };
    }

    if (method === 'resources/read') {
        if (params.uri !== RESOURCE_URI) {
            return { status: 404, payload: rpcError(id, -32002, `Resource not found: ${params.uri || ''}`) };
        }
        const authorization = await authorize(request);
        if (!authorization.ok) {
            const challenge = buildAuthChallenge(request, authorization.reason);
            return {
                status: 401,
                headers: { 'WWW-Authenticate': challenge },
                payload: rpcError(id, -32001, authorization.reason)
            };
        }
        try {
            const profile = await loadProfile(request);
            return { status: 200, payload: rpcResult(id, withResultType({
                contents: [{ uri: RESOURCE_URI, mimeType: 'text/markdown', text: profile }],
                ttlMs: 60000,
                cacheScope: 'private'
            }, mode)) };
        } catch (error) {
            return { status: 200, payload: rpcResult(id, withResultType({
                contents: [{ uri: RESOURCE_URI, mimeType: 'text/plain', text: `Unable to load research profile: ${error.message}` }],
                isError: true
            }, mode)) };
        }
    }

    if (method === 'prompts/list') {
        return { status: 200, payload: rpcResult(id, withResultType({
            prompts: [{
                name: PROMPT_NAME,
                title: 'Research with the PhD corpus',
                description: 'Ground a research question in the private PhD corpus and preserve its author-year citations.',
                arguments: [
                    { name: 'question', description: 'Research question to investigate', required: true },
                    { name: 'detail', description: 'standard or detailed', required: false }
                ]
            }],
            ttlMs: 300000,
            cacheScope: 'public'
        }, mode)) };
    }

    if (method === 'prompts/get') {
        if (params.name !== PROMPT_NAME) {
            return { status: 400, payload: rpcError(id, -32602, `Unknown prompt: ${params.name || ''}`) };
        }
        const question = (params.arguments?.question || '').toString().trim();
        if (!question) return { status: 400, payload: rpcError(id, -32602, 'question is required') };
        const detail = params.arguments?.detail === 'detailed' ? 'detailed' : 'standard';
        return { status: 200, payload: rpcResult(id, withResultType({
            description: 'Research the question against the PhD corpus before drafting.',
            messages: [{
                role: 'user',
                content: {
                    type: 'text',
                    text: `Call ${TOOL_NAME} with detail \"${detail}\" for this question:\n\n${question}\n\nSynthesize only supported claims, preserve author-year citations beside the relevant sentences, and state any corpus limitations.`
                }
            }]
        }, mode)) };
    }

    return { status: 404, payload: rpcError(id, -32601, `Method not found: ${method}`) };
}

function createMcpHandler(options = {}) {
    return async (request, context) => {
        if (!isOriginAllowed(request)) {
            return jsonResponse(request, 403, rpcError(null, -32000, 'Origin is not allowed'));
        }
        if (request.method === 'OPTIONS') {
            return { status: 204, headers: corsHeaders(request) };
        }
        if (request.method !== 'POST') {
            return jsonResponse(request, 405, rpcError(null, -32600, 'MCP Streamable HTTP accepts POST requests'));
        }

        let body;
        try {
            body = await request.json();
        } catch {
            return jsonResponse(request, 400, rpcError(null, -32700, 'Parse error'));
        }

        if (!body || Array.isArray(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
            return jsonResponse(request, 400, rpcError(body?.id, -32600, 'Invalid JSON-RPC request'));
        }

        if (body.id === undefined) {
            if (body.method === 'notifications/initialized' || body.method === 'notifications/cancelled') {
                return { status: 202, headers: corsHeaders(request) };
            }
            return jsonResponse(request, 400, rpcError(null, -32600, 'Unsupported notification'));
        }

        const protocol = validateProtocolRequest(request, body);
        if (!protocol.ok) return jsonResponse(request, protocol.status, protocol.error);

        const fetchImpl = options.fetchImpl || fetch;
        const authorize = options.dependencies?.authorize || (req => authorizeRequest(req, fetchImpl));
        const authorization = await authorize(request);
        if (!authorization.ok) {
            const challenge = buildAuthChallenge(request, authorization.reason, authorization.error);
            return jsonResponse(
                request,
                authorization.status || 401,
                rpcError(body.id, -32000, authorization.reason),
                { 'WWW-Authenticate': challenge }
            );
        }

        const dispatched = await dispatchRpc({
            request,
            context,
            body,
            mode: protocol.mode,
            fetchImpl,
            dependencies: {
                ...(options.dependencies || {}),
                authorize: async () => authorization
            }
        });
        return jsonResponse(request, dispatched.status, dispatched.payload, dispatched.headers || {});
    };
}

app.http('PhdRagMcp', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'mcp',
    handler: createMcpHandler()
});

app.http('PhdRagMcpProtectedResourceMetadata', {
    methods: ['GET', 'OPTIONS'],
    authLevel: 'anonymous',
    route: '.well-known/oauth-protected-resource',
    handler: async request => {
        if (!isOriginAllowed(request)) return jsonResponse(request, 403, { error: 'Origin is not allowed' });
        if (request.method === 'OPTIONS') return { status: 204, headers: corsHeaders(request) };
        const configuredAuthorizationServer = (process.env.MCP_OAUTH_AUTHORIZATION_SERVER || process.env.MCP_OAUTH_ISSUER || '').trim();
        const authorizationServer = configuredAuthorizationServer
            ? `${configuredAuthorizationServer.replace(/\/+$/, '')}/`
            : '';
        if (!authorizationServer) {
            return jsonResponse(request, 404, { error: 'OAuth is not configured for this MCP server' });
        }
        return jsonResponse(request, 200, {
            resource: getCanonicalMcpUrl(request),
            authorization_servers: [authorizationServer],
            scopes_supported: [process.env.MCP_OAUTH_SCOPE || DEFAULT_SCOPE],
            bearer_methods_supported: ['header']
        });
    }
});

module.exports = {
    CURRENT_PROTOCOL_VERSION,
    LEGACY_PROTOCOL_VERSIONS,
    SUPPORTED_PROTOCOL_VERSIONS,
    RESOURCE_URI,
    TOOL_NAME,
    PROMPT_NAME,
    createMcpHandler,
    dispatchRpc,
    formatAnswerForMcp,
    getToolDefinition,
    validateProtocolRequest,
    verifyOauthToken
};
