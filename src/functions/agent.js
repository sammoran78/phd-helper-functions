const { app } = require('@azure/functions');
const { google } = require('googleapis');
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

function toJsonResponse(status, payload) {
    return {
        status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    };
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

async function upsertTaskFromMessage(messageDetail) {
    const payload = messageDetail?.payload || {};
    const headers = payload.headers || [];

    const subject = parseHeader(headers, 'Subject') || 'No subject';
    const from = parseHeader(headers, 'From') || 'Unknown sender';
    const date = parseHeader(headers, 'Date') || null;
    const snippet = (messageDetail?.snippet || '').trim();
    const sourceMessageId = messageDetail?.id;

    if (!sourceMessageId) return null;

    const docId = `agent_task_${sourceMessageId}`;
    const existing = await getItem(ANALYTICS_CONTAINER, docId, docId);

    if (existing?.status && existing.status !== 'open') {
        return existing;
    }

    const nowIso = new Date().toISOString();
    const title = inferTaskTitle(subject, snippet);
    const desc = `From ${truncate(from, 80)} — ${truncate(snippet || subject, 220)}`;

    const taskDoc = {
        id: docId,
        type: 'agent_task',
        source: 'Gmail Agent',
        sourceType: 'gmail',
        sourceMessageId,
        title,
        desc,
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
        query: `SELECT TOP ${cappedLimit} c.id, c.title, c.desc, c.source, c.status, c.createdAt, c.updatedAt, c.evidence FROM c WHERE c.type = "agent_task" AND c.status = "open" ORDER BY c.createdAt DESC`
    });
    return Array.isArray(results) ? results : [];
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
        try {
            const gmail = await getAuthorizedGmailClient();
            if (!gmail) {
                return toJsonResponse(400, { error: 'Gmail is not connected. Connect OAuth first.' });
            }

            const maxResults = Number.isFinite(DEFAULT_EMAIL_MAX_MESSAGES) && DEFAULT_EMAIL_MAX_MESSAGES > 0
                ? Math.min(DEFAULT_EMAIL_MAX_MESSAGES, 50)
                : 15;

            const listRes = await gmail.users.messages.list({
                userId: 'me',
                maxResults,
                q: DEFAULT_EMAIL_QUERY
            });

            const messages = Array.isArray(listRes?.data?.messages) ? listRes.data.messages : [];

            let createdOrUpdated = 0;
            for (const message of messages) {
                const detailRes = await gmail.users.messages.get({
                    userId: 'me',
                    id: message.id,
                    format: 'metadata',
                    metadataHeaders: ['Subject', 'From', 'Date']
                });

                const taskDoc = await upsertTaskFromMessage(detailRes?.data);
                if (taskDoc) createdOrUpdated += 1;
            }

            const tasks = await getOpenTasks(12);

            await upsertItem(ANALYTICS_CONTAINER, {
                id: AGENT_EMAIL_LAST_SCAN_DOC_ID,
                type: 'agent_email_scan',
                scannedAt: new Date().toISOString(),
                scannedMessages: messages.length,
                generatedTasks: createdOrUpdated,
                openTaskCount: tasks.length
            });

            return toJsonResponse(200, {
                success: true,
                scannedMessages: messages.length,
                generatedTasks: createdOrUpdated,
                tasks
            });
        } catch (error) {
            context.error('[AgentEmail] scan error', error);
            return toJsonResponse(500, { error: 'Failed to scan inbox', details: error.message });
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

            const querySpec = {
                query: `SELECT TOP ${limit} c.id, c.title, c.desc, c.source, c.status, c.createdAt, c.updatedAt, c.evidence FROM c WHERE c.type = "agent_task" AND c.status = @status ORDER BY c.createdAt DESC`,
                parameters: [{ name: '@status', value: status }]
            };

            const tasks = await queryItems(ANALYTICS_CONTAINER, querySpec);
            return toJsonResponse(200, Array.isArray(tasks) ? tasks : []);
        } catch (error) {
            context.error('[AgentTasks] list error', error);
            return toJsonResponse(500, { error: 'Failed to load agent tasks', details: error.message });
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
