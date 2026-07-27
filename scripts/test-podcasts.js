const assert = require('assert');
const Module = require('module');

const handlers = new Map();
const items = new Map();
const blobs = new Map();

const key = (container, id) => `${container}:${id}`;
const mockApp = {
    http(name, definition) {
        handlers.set(name, definition.handler);
    }
};

const cosmosMock = {
    async getItem(container, id) {
        return items.get(key(container, id)) || null;
    },
    async createItem(container, item) {
        if (items.has(key(container, item.id))) throw new Error('Conflict');
        items.set(key(container, item.id), structuredClone(item));
        return structuredClone(item);
    },
    async upsertItem(container, item) {
        items.set(key(container, item.id), structuredClone(item));
        return structuredClone(item);
    },
    async queryItems(container) {
        return [...items.entries()]
            .filter(([itemKey, value]) => itemKey.startsWith(`${container}:`) && value.type === 'podcast-generation')
            .map(([, value]) => structuredClone(value))
            .filter(value => value.status === 'queued')
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }
};

const blobMock = {
    async uploadBlob(container, blobName, buffer) {
        blobs.set(key(container, blobName), Buffer.from(buffer));
        return `https://storage.example/${container}/${blobName}`;
    },
    async downloadBlob(container, blobName) {
        const value = blobs.get(key(container, blobName));
        if (!value) throw new Error('Blob not found');
        return Buffer.from(value);
    },
    async deleteBlob(container, blobName) {
        blobs.delete(key(container, blobName));
    }
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '@azure/functions') return { app: mockApp };
    if (request.endsWith('shared/cosmosClient') || request === '../../shared/cosmosClient') return cosmosMock;
    if (request.endsWith('shared/blobClient') || request === '../../shared/blobClient') return blobMock;
    if (request.endsWith('shared/requestAuth') || request === '../../shared/requestAuth') {
        return {
            verifyDashboardRequest: () => ({ email: 'owner@example.com' }),
            verifyWorkerRequest: () => true
        };
    }
    return originalLoad(request, parent, isMain);
};

require('../src/functions/podcasts');
Module._load = originalLoad;

function request({ params = {}, body = {}, query = '' } = {}) {
    return {
        params,
        headers: new Headers(),
        query: new URLSearchParams(query),
        async json() {
            return body;
        }
    };
}

function parseJson(response) {
    return response?.body ? JSON.parse(response.body) : null;
}

async function run() {
    const reference = {
        id: 'ref-1',
        title: 'A Test Paper',
        files: [{
            name: 'paper.pdf',
            blobName: 'papers/paper.pdf',
            contentType: 'application/pdf'
        }]
    };
    items.set(key('references', reference.id), structuredClone(reference));
    blobs.set(key('uploads', 'papers/paper.pdf'), Buffer.from('%PDF-test'));

    const created = await handlers.get('CreateReferencePodcast')(
        request({ params: { id: reference.id } }),
        console
    );
    assert.equal(created.status, 202);
    const createdPayload = parseJson(created);
    assert.ok(createdPayload.jobId);
    assert.equal(createdPayload.podcast.status, 'queued');

    const duplicate = await handlers.get('CreateReferencePodcast')(
        request({ params: { id: reference.id } }),
        console
    );
    assert.equal(duplicate.status, 202);
    assert.equal(parseJson(duplicate).jobId, createdPayload.jobId);

    const claimed = await handlers.get('ClaimPodcastJob')(request(), console);
    assert.equal(claimed.status, 200);
    const claimPayload = parseJson(claimed);
    assert.equal(claimPayload.job.id, createdPayload.jobId);
    assert.equal(claimPayload.reference.pdf.blobName, 'papers/paper.pdf');

    const source = await handlers.get('DownloadPodcastJobSource')(
        request({ params: { jobId: createdPayload.jobId } }),
        console
    );
    assert.equal(source.status, 200);
    assert.equal(Buffer.from(source.body).toString(), '%PDF-test');

    const progressed = await handlers.get('UpdatePodcastJobProgress')(
        request({
            params: { jobId: createdPayload.jobId },
            body: {
                status: 'generating',
                progress: 60,
                stage: 'Generating',
                notebookId: 'notebook-1',
                artifactId: 'artifact-1'
            }
        }),
        console
    );
    assert.equal(progressed.status, 200);

    const failed = await handlers.get('UpdatePodcastJobProgress')(
        request({
            params: { jobId: createdPayload.jobId },
            body: {
                status: 'error',
                progress: 0,
                stage: 'Audio download failed',
                error: 'Test failure',
                notebookId: 'notebook-1',
                artifactId: 'artifact-1'
            }
        }),
        console
    );
    assert.equal(failed.status, 200);

    const resumed = await handlers.get('CreateReferencePodcast')(
        request({
            params: { id: reference.id },
            body: { retry: true }
        }),
        console
    );
    assert.equal(resumed.status, 202);
    assert.equal(parseJson(resumed).jobId, createdPayload.jobId);
    assert.equal(parseJson(resumed).resumed, true);

    const reclaimed = await handlers.get('ClaimPodcastJob')(request(), console);
    assert.equal(reclaimed.status, 200);
    assert.equal(parseJson(reclaimed).job.id, createdPayload.jobId);

    const audioData = Buffer.from('ID3-test-audio');
    const uploaded = await handlers.get('UploadPodcastJobAudio')(
        request({
            params: { jobId: createdPayload.jobId },
            body: {
                fileName: 'audio-overview.mp3',
                fileData: audioData.toString('base64'),
                contentType: 'audio/mpeg',
                notebookId: 'notebook-1',
                artifactId: 'artifact-1'
            }
        }),
        console
    );
    assert.equal(uploaded.status, 200);
    const uploadedPayload = parseJson(uploaded);
    assert.equal(uploadedPayload.podcast.status, 'complete');
    assert.equal(uploadedPayload.podcast.sizeBytes, audioData.length);
    assert.equal(uploadedPayload.podcast.consumedAt, null);

    const status = await handlers.get('GetReferencePodcast')(
        request({ params: { id: reference.id } }),
        console
    );
    assert.equal(parseJson(status).podcast.status, 'complete');

    const audio = await handlers.get('GetReferencePodcastAudio')(
        request({ params: { id: reference.id } }),
        console
    );
    assert.equal(audio.status, 200);
    assert.equal(Buffer.from(audio.body).toString(), audioData.toString());

    const consumed = await handlers.get('MarkReferencePodcastConsumed')(
        request({
            params: { id: reference.id },
            body: { method: 'downloaded' }
        }),
        console
    );
    assert.equal(consumed.status, 200);
    const consumedPayload = parseJson(consumed);
    assert.equal(consumedPayload.podcast.consumedMethod, 'downloaded');
    assert.ok(consumedPayload.podcast.consumedAt);
    assert.equal(consumedPayload.alreadyConsumed, false);

    const consumedAgain = await handlers.get('MarkReferencePodcastConsumed')(
        request({
            params: { id: reference.id },
            body: { method: 'played' }
        }),
        console
    );
    assert.equal(consumedAgain.status, 200);
    assert.equal(parseJson(consumedAgain).alreadyConsumed, true);
    assert.equal(
        parseJson(consumedAgain).podcast.consumedAt,
        consumedPayload.podcast.consumedAt
    );

    console.log('Podcast function workflow test passed');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
