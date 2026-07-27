const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

loadEnvFile(path.join(__dirname, '.env'));

const API_BASE = (
    process.env.PHD_HELPER_API_BASE
    || 'https://phd-function-app-dwbbgeeza3fyhuej.australiaeast-01.azurewebsites.net'
).replace(/\/+$/, '');
const WORKER_TOKEN = process.env.PODCAST_WORKER_TOKEN || '';
const POLL_MS = Number(process.env.PODCAST_WORKER_POLL_MS || 10000);
const GENERATION_TIMEOUT_MS = Number(process.env.PODCAST_GENERATION_TIMEOUT_MS || 30 * 60 * 1000);
const RUN_ONCE = /^true$/i.test(process.env.PODCAST_WORKER_ONCE || '');
const KEEP_NOTEBOOKS = /^true$/i.test(process.env.PODCAST_KEEP_NOTEBOOKS || '');
const LOCAL_MCP_COMMAND = path.join(__dirname, '.venv', 'Scripts', 'notebooklm-mcp.exe');
const MCP_COMMAND = process.env.NOTEBOOKLM_MCP_COMMAND
    || (fs.existsSync(LOCAL_MCP_COMMAND) ? LOCAL_MCP_COMMAND : 'notebooklm-mcp');
const MCP_ARGS = parseJsonArray(process.env.NOTEBOOKLM_MCP_ARGS || '[]');

let stopping = false;

function loadEnvFile(filePath) {
    if (!fs.existsSync(filePath)) return;
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const index = trimmed.indexOf('=');
        if (index <= 0) continue;
        const key = trimmed.slice(0, index).trim();
        let value = trimmed.slice(index + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (!(key in process.env)) process.env[key] = value;
    }
}

function parseJsonArray(value) {
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
        throw new Error('NOTEBOOKLM_MCP_ARGS must be a JSON array');
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function workerHeaders(extra = {}) {
    return {
        'x-podcast-worker-token': WORKER_TOKEN,
        ...extra
    };
}

async function apiFetch(route, options = {}) {
    const response = await fetch(`${API_BASE}/api${route}`, {
        ...options,
        headers: workerHeaders(options.headers || {})
    });
    if (!response.ok && response.status !== 204) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.details || payload.error || `Function API returned HTTP ${response.status}`);
    }
    return response;
}

async function claimJob() {
    const response = await apiFetch('/podcast-worker/claim', { method: 'POST' });
    return response.status === 204 ? null : response.json();
}

async function reportProgress(jobId, update) {
    await apiFetch(`/podcast-worker/jobs/${encodeURIComponent(jobId)}/progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(update)
    });
}

async function downloadSource(jobId, destination) {
    const response = await apiFetch(`/podcast-worker/jobs/${encodeURIComponent(jobId)}/source`);
    const buffer = Buffer.from(await response.arrayBuffer());
    await fsp.writeFile(destination, buffer);
    return buffer.length;
}

async function uploadAudio(jobId, audioPath, metadata) {
    const data = await fsp.readFile(audioPath);
    const extension = path.extname(audioPath).toLowerCase();
    const contentType = extension === '.m4a' || extension === '.mp4'
        ? 'audio/mp4'
        : 'audio/mpeg';
    const response = await apiFetch(`/podcast-worker/jobs/${encodeURIComponent(jobId)}/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            fileName: path.basename(audioPath),
            fileData: data.toString('base64'),
            contentType,
            ...metadata
        })
    });
    return response.json();
}

function extractToolPayload(result) {
    if (result?.structuredContent && typeof result.structuredContent === 'object') {
        return result.structuredContent;
    }
    for (const item of result?.content || []) {
        if (item?.type !== 'text' || !item.text) continue;
        try {
            return JSON.parse(item.text);
        } catch {}
    }
    return result || {};
}

function assertToolSuccess(name, payload) {
    if (!payload || payload.status === 'error' || payload.isError || payload.error) {
        const detail = payload?.error || payload?.message || `${name} failed`;
        throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
    }
}

function findId(payload, keys) {
    for (const key of keys) {
        if (payload?.[key]) return payload[key];
    }
    for (const container of ['notebook', 'source', 'artifact', 'result']) {
        const nested = payload?.[container];
        if (!nested) continue;
        for (const key of keys) {
            if (nested?.[key]) return nested[key];
        }
    }
    return null;
}

async function connectMcp() {
    const [{ Client }, { StdioClientTransport }] = await Promise.all([
        import('@modelcontextprotocol/sdk/client/index.js'),
        import('@modelcontextprotocol/sdk/client/stdio.js')
    ]);
    const client = new Client(
        { name: 'phd-helper-podcast-worker', version: '1.0.0' },
        { capabilities: {} }
    );
    const transport = new StdioClientTransport({
        command: MCP_COMMAND,
        args: MCP_ARGS,
        stderr: 'inherit'
    });
    await client.connect(transport);
    return client;
}

async function callTool(client, name, args) {
    const result = await client.callTool({ name, arguments: args });
    const payload = extractToolPayload(result);
    assertToolSuccess(name, payload);
    return payload;
}

async function waitForAudio(client, jobId, notebookId, artifactId) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < GENERATION_TIMEOUT_MS) {
        const payload = await callTool(client, 'studio_status', {
            notebook_id: notebookId,
            artifact_id: artifactId,
            include_details: false
        });
        const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : [];
        const artifact = artifacts.find(item =>
            item?.artifact_id === artifactId || item?.id === artifactId
        ) || artifacts[0];
        const status = (artifact?.status || '').toString().toLowerCase();
        if (['completed', 'complete', 'ready'].includes(status)) return artifact;
        if (['failed', 'error'].includes(status)) {
            throw new Error(artifact?.error_reason || 'NotebookLM audio generation failed');
        }
        const elapsedRatio = (Date.now() - startedAt) / GENERATION_TIMEOUT_MS;
        const progress = Math.min(88, 45 + Math.round(elapsedRatio * 40));
        await reportProgress(jobId, {
            status: 'generating',
            progress,
            stage: 'NotebookLM is creating the two-host discussion',
            notebookId,
            artifactId
        });
        await sleep(12000);
    }
    throw new Error('NotebookLM audio generation timed out');
}

async function processJob(claim) {
    const { job, reference } = claim;
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), `phd-podcast-${job.id}-`));
    const pdfPath = path.join(tempDir, 'paper.pdf');
    // NotebookLM currently delivers AAC audio in an MP4 container.
    const audioPath = path.join(tempDir, 'audio-overview.m4a');
    let client = null;
    let notebookId = job.notebookId || null;
    let sourceId = job.sourceId || null;
    let artifactId = job.artifactId || null;
    let uploaded = false;

    try {
        await reportProgress(job.id, {
            status: 'processing',
            progress: 10,
            stage: 'Downloading the paper from Azure'
        });
        await downloadSource(job.id, pdfPath);

        await reportProgress(job.id, {
            status: 'processing',
            progress: 18,
            stage: 'Connecting to NotebookLM'
        });
        client = await connectMcp();

        if (notebookId && artifactId) {
            await reportProgress(job.id, {
                status: 'generating',
                progress: 82,
                stage: 'Resuming the completed NotebookLM audio',
                notebookId,
                sourceId,
                artifactId
            });
        } else {
            const notebook = await callTool(client, 'notebook_create', {
                title: `PhD Helper Podcast - ${(reference.title || 'Research paper').slice(0, 120)}`
            });
            notebookId = findId(notebook, ['notebook_id', 'id']);
            if (!notebookId) throw new Error('NotebookLM did not return a notebook ID');
            await reportProgress(job.id, {
                status: 'processing',
                progress: 25,
                stage: 'Temporary NotebookLM notebook created',
                notebookId
            });

            const source = await callTool(client, 'source_add', {
                notebook_id: notebookId,
                source_type: 'file',
                file_path: pdfPath,
                wait: true,
                wait_timeout: 300
            });
            sourceId = findId(source, ['source_id', 'id']);
            await reportProgress(job.id, {
                status: 'processing',
                progress: 40,
                stage: 'Paper processed by NotebookLM',
                notebookId,
                sourceId
            });

            const created = await callTool(client, 'studio_create', {
                notebook_id: notebookId,
                artifact_type: 'audio',
                source_ids: sourceId ? [sourceId] : null,
                confirm: true,
                audio_format: 'deep_dive',
                audio_length: 'default',
                language: 'en',
                focus_prompt: 'Discuss this academic paper clearly and critically, covering its research question, methods, principal findings, limitations, and implications for future research.'
            });
            artifactId = findId(created, ['artifact_id', 'id']);
            if (!artifactId) throw new Error('NotebookLM did not return an audio artifact ID');
            await reportProgress(job.id, {
                status: 'generating',
                progress: 45,
                stage: 'NotebookLM is creating the two-host discussion',
                notebookId,
                sourceId,
                artifactId
            });
        }

        await waitForAudio(client, job.id, notebookId, artifactId);
        await reportProgress(job.id, {
            status: 'uploading',
            progress: 90,
            stage: 'Downloading the completed audio',
            notebookId,
            sourceId,
            artifactId
        });
        await callTool(client, 'download_artifact', {
            notebook_id: notebookId,
            artifact_type: 'audio',
            artifact_id: artifactId,
            output_path: audioPath
        });

        await reportProgress(job.id, {
            status: 'uploading',
            progress: 96,
            stage: 'Uploading podcast to Azure Blob Storage',
            notebookId,
            sourceId,
            artifactId
        });
        await uploadAudio(job.id, audioPath, { notebookId, sourceId, artifactId });
        uploaded = true;
        console.log(`[PodcastWorker] Completed ${job.id}: ${reference.title}`);
    } catch (error) {
        console.error(`[PodcastWorker] Job ${job.id} failed:`, error);
        try {
            await reportProgress(job.id, {
                status: 'error',
                progress: 0,
                stage: /auth|login|cookie/i.test(error.message)
                    ? 'NotebookLM sign-in required'
                    : 'Podcast generation failed',
                error: error.message,
                notebookId,
                sourceId,
                artifactId
            });
        } catch (reportError) {
            console.error('[PodcastWorker] Could not report failure:', reportError);
        }
    } finally {
        if (client && notebookId && uploaded && !KEEP_NOTEBOOKS) {
            try {
                await callTool(client, 'notebook_delete', {
                    notebook_id: notebookId,
                    confirm: true
                });
            } catch (cleanupError) {
                console.warn(`[PodcastWorker] Temporary notebook cleanup failed: ${cleanupError.message}`);
            }
        }
        if (client) {
            try {
                await client.close();
            } catch {}
        }
        await fsp.rm(tempDir, { recursive: true, force: true });
    }
}

async function main() {
    if (!API_BASE) throw new Error('PHD_HELPER_API_BASE is required');
    if (!WORKER_TOKEN) throw new Error('PODCAST_WORKER_TOKEN is required');

    console.log(`[PodcastWorker] Watching ${API_BASE} for podcast jobs`);
    while (!stopping) {
        try {
            const claim = await claimJob();
            if (claim?.job) {
                await processJob(claim);
                if (RUN_ONCE) break;
                continue;
            }
            if (RUN_ONCE) break;
        } catch (error) {
            console.error('[PodcastWorker] Poll failed:', error.message);
            if (RUN_ONCE) process.exitCode = 1;
        }
        await sleep(POLL_MS);
    }
}

process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

main().catch(error => {
    console.error('[PodcastWorker] Fatal error:', error);
    process.exitCode = 1;
});
