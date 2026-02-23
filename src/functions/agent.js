const { app } = require('@azure/functions');
const { google } = require('googleapis');
const OpenAI = require('openai');
const { getItem, queryItems, upsertItem, replaceItem } = require('../../shared/cosmosClient');

const ANALYTICS_CONTAINER = process.env.COSMOSDB_CONTAINER_ANALYTICS || 'analytics';

const AGENT_EMAIL_OAUTH_DOC_ID = 'agent_email_oauth';
const AGENT_EMAIL_OAUTH_STATE_DOC_ID = 'agent_email_oauth_state';
const AGENT_EMAIL_LAST_SCAN_DOC_ID = 'agent_email_last_scan';

const DEFAULT_EMAIL_QUERY = process.env.AGENT_EMAIL_QUERY || 'newer_than:7d -category:promotions -category:social';
const DEFAULT_EMAIL_MAX_MESSAGES = Number.parseInt(process.env.AGENT_EMAIL_MAX_MESSAGES || '15', 10);

const AGENT_GMAIL_SCOPES = [
    'https://www.googleapis.com/auth/gmail.readonly'
];

let agentOpenAiClient = null;

function toJsonResponse(status, payload) {
    return {
        status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    };
}

function fallbackMorningBrief(topTasks) {
    if (!Array.isArray(topTasks) || topTasks.length === 0) {
        return 'No urgent items this morning. Run an inbox scan to generate fresh tasks.';
    }

    const lines = topTasks.map((task, idx) => {
        const pri = normalizePriority(task?.priority);
        return `${idx + 1}. [${pri.toUpperCase()}] ${(task?.title || 'Untitled task').toString()}`;
    });
    return `Morning brief: focus on these ${topTasks.length} tasks first.\n${lines.join('\n')}`;
}

async function buildMorningBriefFromTasks(tasks, context) {
    const taskList = Array.isArray(tasks) ? tasks : [];
    const ranked = taskList
        .slice()
        .sort((a, b) => {
            const priDiff = priorityRank(b?.priority) - priorityRank(a?.priority);
            if (priDiff !== 0) return priDiff;

            const aConf = Number.parseFloat(a?.confidence);
            const bConf = Number.parseFloat(b?.confidence);
            const safeAConf = Number.isFinite(aConf) ? aConf : -1;
            const safeBConf = Number.isFinite(bConf) ? bConf : -1;
            if (safeBConf !== safeAConf) return safeBConf - safeAConf;

            return new Date(b?.createdAt || 0).getTime() - new Date(a?.createdAt || 0).getTime();
        });
    const topTasks = ranked.slice(0, 3);

    if (topTasks.length === 0) {
        return {
            summary: fallbackMorningBrief(topTasks),
            tasks: [],
            generatedAt: new Date().toISOString(),
            source: 'fallback'
        };
    }

    const client = getAgentOpenAiClient();
    const model = (process.env.AGENT_EMAIL_LLM_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini').toString().trim();
    if (!client || !model) {
        return {
            summary: fallbackMorningBrief(topTasks),
            tasks: topTasks,
            generatedAt: new Date().toISOString(),
            source: 'fallback'
        };
    }

    try {
        const completion = await client.chat.completions.create({
            model,
            temperature: 0.2,
            response_format: { type: 'json_object' },
            messages: [
                {
                    role: 'system',
                    content: 'You are a concise PhD productivity coach. Return strict JSON only.'
                },
                {
                    role: 'user',
                    content: JSON.stringify({
                        task: 'Write a short morning brief from top tasks.',
                        outputSchema: {
                            summary: '2-4 sentences with clear action order',
                            focusOrder: [{ taskId: 'agent task id', reason: 'short reason' }]
                        },
                        tasks: topTasks.map((task) => ({
                            id: task.id,
                            title: task.title,
                            desc: task.desc,
                            priority: normalizePriority(task.priority),
                            confidence: task.confidence,
                            rationale: task.rationale || ''
                        }))
                    })
                }
            ]
        });

        const parsed = JSON.parse(completion?.choices?.[0]?.message?.content || '{}');
        const summary = truncate((parsed?.summary || '').toString().trim(), 480) || fallbackMorningBrief(topTasks);

        const focusOrderRaw = Array.isArray(parsed?.focusOrder) ? parsed.focusOrder : [];
        const byId = new Map(topTasks.map((task) => [task.id, task]));
        const ordered = [];
        for (const item of focusOrderRaw) {
            const taskId = (item?.taskId || '').toString().trim();
            if (!taskId || !byId.has(taskId)) continue;
            ordered.push({
                ...byId.get(taskId),
                briefReason: truncate((item?.reason || '').toString(), 140)
            });
            byId.delete(taskId);
        }
        ordered.push(...Array.from(byId.values()));

        return {
            summary,
            tasks: ordered.slice(0, 3),
            generatedAt: new Date().toISOString(),
            source: 'openai'
        };
    } catch (error) {
        context?.warn('[AgentEmail] morning brief synthesis failed, using fallback', {
            error: error?.message || 'Unknown error'
        });
        return {
            summary: fallbackMorningBrief(topTasks),
            tasks: topTasks,
            generatedAt: new Date().toISOString(),
            source: 'fallback'
        };
    }
}

function clampConfidence(value) {
    const n = Number.parseFloat(value);
    if (!Number.isFinite(n)) return null;
    if (n < 0) return 0;
    if (n > 1) return 1;
    return n;
}

function normalizePriority(value) {
    const v = (value || '').toString().trim().toLowerCase();
    if (v === 'high' || v === 'medium' || v === 'low') return v;
    return 'medium';
}

function priorityRank(value) {
    const v = normalizePriority(value);
    if (v === 'high') return 3;
    if (v === 'medium') return 2;
    return 1;
}

function getAgentOpenAiClient() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return null;
    if (!agentOpenAiClient) {
        agentOpenAiClient = new OpenAI({ apiKey });
    }
    return agentOpenAiClient;
}

async function synthesizeEmailTasks(messageSignals, context) {
    if (!Array.isArray(messageSignals) || messageSignals.length === 0) return [];

    const client = getAgentOpenAiClient();
    if (!client) return [];

    const model = (process.env.AGENT_EMAIL_LLM_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini').toString().trim();
    if (!model) return [];

    const trimmedSignals = messageSignals.slice(0, 20).map((signal) => ({
        sourceMessageId: signal.sourceMessageId,
        subject: signal.subject,
        from: signal.from,
        date: signal.date,
        snippet: truncate(signal.snippet, 260)
    }));

    try {
        const completion = await client.chat.completions.create({
            model,
            temperature: 0.2,
            response_format: { type: 'json_object' },
            messages: [
                {
                    role: 'system',
                    content: 'You are a PhD productivity supervisor. Generate concise actionable tasks from inbox signals. Return strict JSON only.'
                },
                {
                    role: 'user',
                    content: JSON.stringify({
                        task: 'Rank signals and return up to 3 actionable tasks with rationale and confidence.',
                        constraints: {
                            maxTasks: 3,
                            confidenceRange: '0-1',
                            priorities: ['high', 'medium', 'low']
                        },
                        outputSchema: {
                            tasks: [
                                {
                                    sourceMessageId: 'gmail message id',
                                    title: 'short action title',
                                    desc: 'single sentence action-oriented description',
                                    rationale: 'why this matters now',
                                    confidence: 0.75,
                                    priority: 'high'
                                }
                            ]
                        },
                        signals: trimmedSignals
                    })
                }
            ]
        });

        const payload = JSON.parse(completion?.choices?.[0]?.message?.content || '{}');
        const tasks = Array.isArray(payload?.tasks) ? payload.tasks : [];

        return tasks
            .map((item) => ({
                sourceMessageId: (item?.sourceMessageId || '').toString().trim(),
                title: truncate(item?.title || '', 72),
                desc: truncate(item?.desc || '', 220),
                rationale: truncate(item?.rationale || '', 220),
                confidence: clampConfidence(item?.confidence),
                priority: normalizePriority(item?.priority)
            }))
            .filter((item) => item.sourceMessageId);
    } catch (error) {
        context?.warn('[AgentEmail] synthesis failed, falling back to rule-based tasks', {
            error: error?.message || 'Unknown error'
        });
        return [];
    }
}

function getAgentOAuthConfig() {
    const clientId = process.env.AGENT_EMAIL_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.AGENT_EMAIL_GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const redirectUri = process.env.AGENT_EMAIL_GOOGLE_REDIRECT_URI;

    if (!clientId || !clientSecret || !redirectUri) {
        return null;
    }

    return { clientId, clientSecret, redirectUri };
}

function buildOAuthClient() {
    const config = getAgentOAuthConfig();
    if (!config) return null;
    return new google.auth.OAuth2(config.clientId, config.clientSecret, config.redirectUri);
}

async function getAgentOAuthRecord() {
    return getItem(ANALYTICS_CONTAINER, AGENT_EMAIL_OAUTH_DOC_ID, AGENT_EMAIL_OAUTH_DOC_ID);
}

async function getAuthorizedGmailClient() {
    const oauthRecord = await getAgentOAuthRecord();
    if (!oauthRecord?.refreshToken) {
        return null;
    }

    const oauth2Client = buildOAuthClient();
    if (!oauth2Client) {
        throw new Error('Agent OAuth client is not configured. Set AGENT_EMAIL_GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI');
    }

    oauth2Client.setCredentials({
        refresh_token: oauthRecord.refreshToken
    });

    const { credentials } = await oauth2Client.refreshAccessToken();
    oauth2Client.setCredentials({
        ...credentials,
        refresh_token: oauthRecord.refreshToken
    });

    if (credentials?.expiry_date || credentials?.access_token) {
        await upsertItem(ANALYTICS_CONTAINER, {
            ...oauthRecord,
            id: AGENT_EMAIL_OAUTH_DOC_ID,
            type: 'agent_email_oauth',
            accessToken: credentials.access_token || oauthRecord.accessToken || null,
            expiryDate: credentials.expiry_date || oauthRecord.expiryDate || null,
            updatedAt: new Date().toISOString()
        });
    }

    return google.gmail({ version: 'v1', auth: oauth2Client });
}

function truncate(value, max = 120) {
    const text = (value || '').toString().trim();
    if (!text) return '';
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function parseHeader(headers, name) {
    if (!Array.isArray(headers)) return '';
    const found = headers.find((h) => (h?.name || '').toLowerCase() === name.toLowerCase());
    return (found?.value || '').toString();
}

function toSafeIdPart(value) {
    const raw = (value || '').toString().trim();
    if (!raw) return '';
    return raw.replace(/[\\/?#]/g, '_');
}

function inferTaskTitle(subject, snippet) {
    const text = `${subject} ${snippet}`.toLowerCase();
    const shortSubject = truncate(subject || 'Inbox item', 72);

    if (/feedback|comments|revise|revision|review/.test(text)) {
        return `Review feedback: ${shortSubject}`;
    }
    if (/deadline|due|submission|submit|urgent/.test(text)) {
        return `Action deadline email: ${shortSubject}`;
    }
    if (/ethics|consent|participant|interview/.test(text)) {
        return `Follow up ethics-related email: ${shortSubject}`;
    }
    if (/meeting|schedule|calendar|appointment/.test(text)) {
        return `Prepare for meeting email: ${shortSubject}`;
    }
    return `Process email: ${shortSubject}`;
}

async function upsertTaskFromMessage(messageDetail, synthesis = null) {
    const payload = messageDetail?.payload || {};
    const headers = payload.headers || [];

    const subject = parseHeader(headers, 'Subject') || 'No subject';
    const from = parseHeader(headers, 'From') || 'Unknown sender';
    const date = parseHeader(headers, 'Date') || null;
    const snippet = (messageDetail?.snippet || '').trim();
    const sourceMessageId = messageDetail?.id;

    if (!sourceMessageId) return null;

    const safeMessageId = toSafeIdPart(sourceMessageId);
    if (!safeMessageId) return null;
    const docId = `agent_task_${safeMessageId}`;
    const existing = await getItem(ANALYTICS_CONTAINER, docId, docId);

    if (existing?.status && existing.status !== 'open') {
        return null;
    }

    const nowIso = new Date().toISOString();
    const title = synthesis?.title || inferTaskTitle(subject, snippet);
    const desc = synthesis?.desc || `From ${truncate(from, 80)} — ${truncate(snippet || subject, 220)}`;

    const taskDoc = {
        id: docId,
        type: 'agent_task',
        source: 'Gmail Agent',
        sourceType: 'gmail',
        sourceMessageId,
        title,
        desc,
        rationale: synthesis?.rationale || existing?.rationale || '',
        confidence: synthesis?.confidence ?? existing?.confidence ?? null,
        priority: synthesis?.priority || existing?.priority || 'medium',
        evidence: {
            subject,
            from,
            date,
            snippet
        },
        status: 'open',
        createdAt: existing?.createdAt || nowIso,
        updatedAt: nowIso
    };

    await upsertItem(ANALYTICS_CONTAINER, taskDoc);
    return taskDoc;
}

async function getOpenTasks(limit = 12) {
    const cappedLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 50) : 12;
    const results = await queryItems(ANALYTICS_CONTAINER, {
        query: 'SELECT c.id, c.title, c.desc, c.source, c.status, c.priority, c.confidence, c.rationale, c.createdAt, c.updatedAt, c.evidence FROM c WHERE c.type = "agent_task" AND c.status = "open"'
    });
    const list = Array.isArray(results) ? results : [];
    return list
        .sort((a, b) => (new Date(b?.createdAt || 0).getTime() - new Date(a?.createdAt || 0).getTime()))
        .slice(0, cappedLimit);
}

app.http('GetAgentEmailStatus', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'agent/email/status',
    handler: async (_request, context) => {
        try {
            const oauthConfig = getAgentOAuthConfig();
            const oauthRecord = await getAgentOAuthRecord();
            const lastScan = await getItem(ANALYTICS_CONTAINER, AGENT_EMAIL_LAST_SCAN_DOC_ID, AGENT_EMAIL_LAST_SCAN_DOC_ID);
            const openTaskCountResult = await queryItems(ANALYTICS_CONTAINER, {
                query: 'SELECT VALUE COUNT(1) FROM c WHERE c.type = "agent_task" AND c.status = "open"'
            });
            const openTaskCount = Array.isArray(openTaskCountResult) && Number.isFinite(openTaskCountResult[0])
                ? openTaskCountResult[0]
                : 0;

            return toJsonResponse(200, {
                oauthConfigured: Boolean(oauthConfig),
                connected: Boolean(oauthRecord?.refreshToken),
                emailAddress: oauthRecord?.emailAddress || null,
                lastScanAt: lastScan?.scannedAt || null,
                openTaskCount
            });
        } catch (error) {
            context.error('[AgentEmail] status error', error);
            return toJsonResponse(500, { error: 'Failed to fetch agent email status', details: error.message });
        }
    }
});

app.http('StartAgentEmailOAuth', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'agent/email/oauth/start',
    handler: async (_request, context) => {
        try {
            const oauth2Client = buildOAuthClient();
            if (!oauth2Client) {
                return toJsonResponse(500, {
                    error: 'Agent email OAuth is not configured',
                    details: 'Set AGENT_EMAIL_GOOGLE_CLIENT_ID, AGENT_EMAIL_GOOGLE_CLIENT_SECRET, and AGENT_EMAIL_GOOGLE_REDIRECT_URI'
                });
            }

            const state = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
            await upsertItem(ANALYTICS_CONTAINER, {
                id: AGENT_EMAIL_OAUTH_STATE_DOC_ID,
                type: 'agent_email_oauth_state',
                state,
                createdAt: new Date().toISOString()
            });

            const authUrl = oauth2Client.generateAuthUrl({
                access_type: 'offline',
                prompt: 'consent',
                scope: AGENT_GMAIL_SCOPES,
                state
            });

            return toJsonResponse(200, { authUrl });
        } catch (error) {
            context.error('[AgentEmail] oauth start error', error);
            return toJsonResponse(500, { error: 'Failed to start OAuth flow', details: error.message });
        }
    }
});

app.http('HandleAgentEmailOAuthCallback', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'agent/email/oauth/callback',
    handler: async (request, context) => {
        try {
            const oauth2Client = buildOAuthClient();
            if (!oauth2Client) {
                return {
                    status: 500,
                    headers: { 'Content-Type': 'text/html; charset=utf-8' },
                    body: '<h3>Agent OAuth is not configured.</h3>'
                };
            }

            const url = new URL(request.url);
            const code = (url.searchParams.get('code') || '').trim();
            const state = (url.searchParams.get('state') || '').trim();
            const errorParam = (url.searchParams.get('error') || '').trim();

            if (errorParam) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'text/html; charset=utf-8' },
                    body: `<h3>Google OAuth failed: ${errorParam}</h3>`
                };
            }

            if (!code || !state) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'text/html; charset=utf-8' },
                    body: '<h3>Missing OAuth code/state.</h3>'
                };
            }

            const stateDoc = await getItem(ANALYTICS_CONTAINER, AGENT_EMAIL_OAUTH_STATE_DOC_ID, AGENT_EMAIL_OAUTH_STATE_DOC_ID);
            if (!stateDoc?.state || stateDoc.state !== state) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'text/html; charset=utf-8' },
                    body: '<h3>Invalid OAuth state. Please retry from dashboard.</h3>'
                };
            }

            const { tokens } = await oauth2Client.getToken(code);
            oauth2Client.setCredentials(tokens);

            const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
            const profile = await gmail.users.getProfile({ userId: 'me' });
            const emailAddress = profile?.data?.emailAddress || null;

            const existing = await getAgentOAuthRecord();
            const refreshToken = tokens?.refresh_token || existing?.refreshToken || null;

            if (!refreshToken) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'text/html; charset=utf-8' },
                    body: '<h3>OAuth token missing refresh token. Re-run connect and grant consent.</h3>'
                };
            }

            await upsertItem(ANALYTICS_CONTAINER, {
                id: AGENT_EMAIL_OAUTH_DOC_ID,
                type: 'agent_email_oauth',
                emailAddress,
                refreshToken,
                accessToken: tokens?.access_token || null,
                expiryDate: tokens?.expiry_date || null,
                scope: tokens?.scope || null,
                updatedAt: new Date().toISOString()
            });

            return {
                status: 200,
                headers: { 'Content-Type': 'text/html; charset=utf-8' },
                body: `<!doctype html><html><body style="font-family: system-ui; padding: 24px;"><h3>✅ Gmail connected for AI Supervisor Agent</h3><p>${emailAddress || ''}</p><p>You can close this window and return to the dashboard.</p><script>setTimeout(function(){ if (window.opener) window.close(); }, 1200);</script></body></html>`
            };
        } catch (error) {
            context.error('[AgentEmail] oauth callback error', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'text/html; charset=utf-8' },
                body: `<h3>OAuth callback failed</h3><pre>${(error?.message || 'Unknown error').toString()}</pre>`
            };
        }
    }
});

app.http('ScanAgentEmailInbox', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'agent/email/scan',
    handler: async (_request, context) => {
        let stage = 'init';
        try {
            stage = 'authorize_gmail';
            const gmail = await getAuthorizedGmailClient();
            if (!gmail) {
                return toJsonResponse(400, { error: 'Gmail is not connected. Connect OAuth first.' });
            }

            stage = 'list_messages';
            const maxResults = Number.isFinite(DEFAULT_EMAIL_MAX_MESSAGES) && DEFAULT_EMAIL_MAX_MESSAGES > 0
                ? Math.min(DEFAULT_EMAIL_MAX_MESSAGES, 50)
                : 15;

            const listRes = await gmail.users.messages.list({
                userId: 'me',
                maxResults,
                q: DEFAULT_EMAIL_QUERY
            });

            const messages = Array.isArray(listRes?.data?.messages) ? listRes.data.messages : [];

            stage = 'fetch_message_details';
            const messageDetails = [];
            for (const message of messages) {
                try {
                    const detailRes = await gmail.users.messages.get({
                        userId: 'me',
                        id: message.id,
                        format: 'metadata',
                        metadataHeaders: ['Subject', 'From', 'Date']
                    });
                    if (detailRes?.data?.id) {
                        messageDetails.push(detailRes.data);
                    }
                } catch (messageError) {
                    context.warn('[AgentEmail] skipped message detail fetch', {
                        messageId: message?.id || null,
                        error: messageError?.message || 'Unknown error'
                    });
                }
            }

            stage = 'synthesize_tasks';
            const synthesis = await synthesizeEmailTasks(
                messageDetails.map((detail) => {
                    const headers = detail?.payload?.headers || [];
                    return {
                        sourceMessageId: detail?.id,
                        subject: parseHeader(headers, 'Subject') || 'No subject',
                        from: parseHeader(headers, 'From') || 'Unknown sender',
                        date: parseHeader(headers, 'Date') || null,
                        snippet: (detail?.snippet || '').trim()
                    };
                }),
                context
            );
            const synthesisByMessageId = new Map(
                synthesis.map((item) => [item.sourceMessageId, item])
            );

            let createdOrUpdated = 0;
            const scannedOpenTasks = [];
            stage = 'process_messages';
            for (const detail of messageDetails) {
                try {
                    const taskDoc = await upsertTaskFromMessage(
                        detail,
                        synthesisByMessageId.get(detail?.id) || null
                    );
                    if (taskDoc?.status === 'open') {
                        createdOrUpdated += 1;
                        scannedOpenTasks.push(taskDoc);
                    }
                } catch (messageError) {
                    context.warn('[AgentEmail] skipped message during scan', {
                        messageId: detail?.id || null,
                        error: messageError?.message || 'Unknown error'
                    });
                }
            }

            let tasks = [];
            stage = 'load_open_tasks';
            try {
                tasks = await getOpenTasks(12);
            } catch (tasksError) {
                context.warn('[AgentEmail] failed to load open tasks after scan', {
                    error: tasksError?.message || 'Unknown error'
                });
                tasks = [];
            }

            if (tasks.length === 0 && scannedOpenTasks.length > 0) {
                const deduped = new Map();
                for (const task of scannedOpenTasks) {
                    if (task?.id) deduped.set(task.id, task);
                }
                tasks = Array.from(deduped.values())
                    .sort((a, b) => (new Date(b?.createdAt || 0).getTime() - new Date(a?.createdAt || 0).getTime()))
                    .slice(0, 12);
            }

            stage = 'save_scan_metadata';
            try {
                await upsertItem(ANALYTICS_CONTAINER, {
                    id: AGENT_EMAIL_LAST_SCAN_DOC_ID,
                    type: 'agent_email_scan',
                    scannedAt: new Date().toISOString(),
                    scannedMessages: messages.length,
                    generatedTasks: createdOrUpdated,
                    openTaskCount: tasks.length
                });
            } catch (metaError) {
                context.warn('[AgentEmail] failed to save scan metadata', {
                    error: metaError?.message || 'Unknown error'
                });
            }

            return toJsonResponse(200, {
                success: true,
                scannedMessages: messages.length,
                generatedTasks: createdOrUpdated,
                tasks
            });
        } catch (error) {
            context.error('[AgentEmail] scan error', error);
            return toJsonResponse(500, {
                error: 'Failed to scan inbox',
                details: error.message,
                stage
            });
        }
    }
});

app.http('GetAgentTasks', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'agent/tasks',
    handler: async (request, context) => {
        try {
            const url = new URL(request.url);
            const status = (url.searchParams.get('status') || 'open').trim().toLowerCase();
            const limitRaw = Number.parseInt(url.searchParams.get('limit') || '20', 10);
            const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 20;

            const tasks = await queryItems(ANALYTICS_CONTAINER, {
                query: 'SELECT c.id, c.title, c.desc, c.source, c.status, c.priority, c.confidence, c.rationale, c.createdAt, c.updatedAt, c.evidence FROM c WHERE c.type = "agent_task" AND c.status = @status',
                parameters: [{ name: '@status', value: status }]
            });

            const list = Array.isArray(tasks) ? tasks : [];
            const sorted = list.sort((a, b) => (new Date(b?.createdAt || 0).getTime() - new Date(a?.createdAt || 0).getTime()));
            return toJsonResponse(200, sorted.slice(0, limit));
        } catch (error) {
            context.error('[AgentTasks] list error', error);
            return toJsonResponse(500, { error: 'Failed to load agent tasks', details: error.message });
        }
    }
});

app.http('GetAgentMorningBrief', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'agent/brief/morning',
    handler: async (_request, context) => {
        try {
            const tasks = await getOpenTasks(12);
            const brief = await buildMorningBriefFromTasks(tasks, context);
            return toJsonResponse(200, brief);
        } catch (error) {
            context.error('[AgentBrief] morning brief error', error);
            return toJsonResponse(500, { error: 'Failed to build morning brief', details: error.message });
        }
    }
});

app.http('UpdateAgentTask', {
    methods: ['PATCH'],
    authLevel: 'anonymous',
    route: 'agent/tasks/{id}',
    handler: async (request, context) => {
        try {
            const id = (request.params?.id || '').trim();
            if (!id) {
                return toJsonResponse(400, { error: 'Task id is required' });
            }

            const body = await request.json();
            const nextStatus = (body?.status || '').toString().trim().toLowerCase();
            if (!['open', 'completed', 'snoozed'].includes(nextStatus)) {
                return toJsonResponse(400, { error: 'status must be one of: open, completed, snoozed' });
            }

            const existing = await getItem(ANALYTICS_CONTAINER, id, id);
            if (!existing || existing.type !== 'agent_task') {
                return toJsonResponse(404, { error: 'Task not found' });
            }

            const updated = {
                ...existing,
                status: nextStatus,
                updatedAt: new Date().toISOString()
            };
            await replaceItem(ANALYTICS_CONTAINER, id, id, updated);

            return toJsonResponse(200, { success: true, task: updated });
        } catch (error) {
            context.error('[AgentTasks] update error', error);
            return toJsonResponse(500, { error: 'Failed to update task', details: error.message });
        }
    }
});
