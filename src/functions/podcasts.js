const { app } = require('@azure/functions');
const crypto = require('crypto');
const {
    queryItems,
    createItem,
    getItem,
    upsertItem
} = require('../../shared/cosmosClient');
const {
    uploadBlob,
    downloadBlob,
    deleteBlob,
    blobExists
} = require('../../shared/blobClient');
const {
    verifyDashboardRequest,
    verifyWorkerRequest
} = require('../../shared/requestAuth');

const REFERENCES_CONTAINER = process.env.COSMOSDB_CONTAINER_REFERENCES || 'references';
const JOBS_CONTAINER = process.env.COSMOSDB_CONTAINER_JOBS || 'jobs';
const UPLOADS_CONTAINER = process.env.BLOB_CONTAINER_UPLOADS || 'uploads';
const JOB_TTL_SECONDS = Number(process.env.PODCAST_JOB_TTL_SECONDS || 7 * 24 * 60 * 60);
const WORKER_LEASE_MS = Number(process.env.PODCAST_WORKER_LEASE_MS || 5 * 60 * 1000);
// The worker sends JSON/base64, so keep the decoded payload comfortably below
// Azure Functions' 100 MB HTTP request limit after base64 expansion.
const MAX_AUDIO_BYTES = Number(process.env.PODCAST_MAX_AUDIO_BYTES || 70 * 1024 * 1024);

const json = (status, payload) => ({
    status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
});

const unauthorized = () => json(401, { error: 'Unauthorized' });
const nowIso = () => new Date().toISOString();

function safeFileName(value, fallback = 'audio-overview.mp3') {
    const cleaned = (value || '')
        .toString()
        .replace(/[\r\n"]/g, '')
        .replace(/[^a-zA-Z0-9._ -]/g, '_')
        .trim();
    return cleaned || fallback;
}

function extractBlobNameFromUrl(url, containerName) {
    const raw = (url || '').toString().trim();
    if (!raw) return '';
    try {
        const parsed = new URL(raw);
        const parts = parsed.pathname.split('/').filter(Boolean);
        const containerIndex = parts.indexOf(containerName);
        return containerIndex >= 0
            ? parts.slice(containerIndex + 1).join('/')
            : parts.slice(1).join('/');
    } catch {
        return '';
    }
}

function findPdf(reference) {
    const files = Array.isArray(reference?.files) ? reference.files : [];
    return files.find(file => {
        const name = (file?.name || file?.fileName || file?.blobName || '').toString().toLowerCase();
        const url = (file?.url || '').toString().toLowerCase();
        const contentType = (file?.contentType || file?.mimeType || '').toString().toLowerCase();
        return name.endsWith('.pdf') || url.endsWith('.pdf') || contentType === 'application/pdf';
    }) || null;
}

function podcastPayload(reference, job = null) {
    const podcast = reference?.podcast || {};
    if (!reference?.podcast && !job) {
        return { status: 'not_created', progress: 0, stage: 'Ready to create' };
    }
    const completedJobMissingAudio = job?.status === 'complete' && !podcast.blobName;
    return {
        ...podcast,
        status: completedJobMissingAudio
            ? 'error'
            : job?.status || podcast.status || 'not_created',
        progress: Number.isFinite(Number(job?.progress))
            ? Number(job.progress)
            : Number(podcast.progress || 0),
        stage: completedJobMissingAudio
            ? 'Podcast audio metadata needs repair'
            : job?.stage || podcast.stage || '',
        error: completedJobMissingAudio
            ? 'The completed podcast job is missing usable audio metadata on its reference.'
            : job?.error || podcast.error || null,
        lastUpdated: job?.lastUpdated || podcast.lastUpdated || null
    };
}

async function loadPodcastJob(reference) {
    const jobId = reference?.podcast?.jobId;
    return jobId ? getItem(JOBS_CONTAINER, jobId, jobId) : null;
}

async function updatePodcastReference(reference, patch) {
    const updated = {
        ...reference,
        podcast: {
            ...(reference.podcast || {}),
            ...patch,
            lastUpdated: nowIso()
        }
    };
    await upsertItem(REFERENCES_CONTAINER, updated);
    return updated;
}

function completedPodcastPatchFromJob(job) {
    if (job?.status !== 'complete' || !job.blobName) return null;
    return {
        status: 'complete',
        progress: 100,
        stage: 'Podcast ready',
        error: null,
        provider: 'notebooklm',
        format: 'deep_dive',
        jobId: job.id,
        notebookId: job.notebookId || null,
        sourceId: job.sourceId || null,
        artifactId: job.artifactId || null,
        blobName: job.blobName,
        url: job.audioUrl || job.url || null,
        fileName: job.fileName || 'audio-overview.mp3',
        contentType: job.contentType || 'audio/mpeg',
        sizeBytes: Number(job.sizeBytes || 0),
        completedAt: job.completedAt || job.lastUpdated || nowIso()
    };
}

async function repairCompletedPodcastReference(reference, job, context) {
    if (reference?.podcast?.status === 'complete' && reference.podcast.blobName) {
        return reference;
    }
    const patch = completedPodcastPatchFromJob(job);
    if (!patch) return reference;
    if (!(await blobExists(UPLOADS_CONTAINER, patch.blobName))) {
        context?.warn?.(`Completed podcast blob is missing for ${reference.id}: ${patch.blobName}`);
        return reference;
    }
    const repaired = await updatePodcastReference(reference, patch);
    context?.log?.(`Repaired podcast metadata for reference ${reference.id} from job ${job.id}`);
    return repaired;
}

async function requireReference(referenceId) {
    return getItem(REFERENCES_CONTAINER, referenceId, referenceId);
}

function shouldStartFreshAttempt(job) {
    const details = `${job?.stage || ''} ${job?.error || ''}`.toLowerCase();
    return /studio status|artifact[^.]*\b(not found|missing|invalid|unavailable)\b|notebook[^.]*\b(not found|missing|invalid)\b/.test(details);
}

app.http('CreateReferencePodcast', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'references/{id}/podcast',
    handler: async (request, context) => {
        if (!verifyDashboardRequest(request)) return unauthorized();
        try {
            let reference = await requireReference(request.params.id);
            if (!reference) return json(404, { error: 'Reference not found' });
            const pdf = findPdf(reference);
            if (!pdf) return json(400, { error: 'This reference does not have an attached PDF' });

            let retry = false;
            let reset = false;
            try {
                const body = await request.json();
                retry = body?.retry === true;
                reset = body?.reset === true;
            } catch {}

            const existing = await loadPodcastJob(reference);
            reference = await repairCompletedPodcastReference(reference, existing, context);
            if (reference.podcast?.status === 'complete' && reference.podcast?.blobName && !retry) {
                return json(200, {
                    success: true,
                    existing: true,
                    podcast: podcastPayload(reference, existing)
                });
            }
            if (existing && ['queued', 'claimed', 'processing', 'generating', 'uploading'].includes(existing.status) && !retry) {
                return json(202, {
                    success: true,
                    existing: true,
                    jobId: existing.id,
                    podcast: podcastPayload(reference, existing)
                });
            }
            const startFresh = retry
                && existing?.status === 'error'
                && (reset || shouldStartFreshAttempt(existing));
            if (retry && existing?.status === 'error' && existing.notebookId && existing.artifactId && !startFresh) {
                const resumedAt = nowIso();
                const resumedJob = {
                    ...existing,
                    status: 'queued',
                    progress: Math.max(Number(existing.progress || 0), 75),
                    stage: 'Waiting for laptop worker to resume audio download',
                    error: null,
                    completedAt: null,
                    leaseExpiresAt: null,
                    lastUpdated: resumedAt
                };
                await upsertItem(JOBS_CONTAINER, resumedJob);
                const updatedReference = await updatePodcastReference(reference, {
                    status: resumedJob.status,
                    progress: resumedJob.progress,
                    stage: resumedJob.stage,
                    error: null
                });
                return json(202, {
                    success: true,
                    resumed: true,
                    jobId: resumedJob.id,
                    podcast: podcastPayload(updatedReference, resumedJob)
                });
            }

            const createdAt = nowIso();
            const job = {
                id: `podcast_${reference.id}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
                type: 'podcast-generation',
                referenceId: reference.id,
                status: 'queued',
                progress: 2,
                stage: 'Waiting for laptop worker',
                createdAt,
                lastUpdated: createdAt,
                attempts: 0,
                error: null,
                ttl: JOB_TTL_SECONDS
            };
            if (startFresh) {
                job.resetFromJobId = existing.id;
                job.cleanupNotebookId = existing.notebookId || null;
                job.stage = 'Waiting for laptop worker to start a fresh attempt';
            }
            await createItem(JOBS_CONTAINER, job);
            const updatedReference = await updatePodcastReference(reference, {
                status: 'queued',
                progress: 2,
                stage: job.stage,
                jobId: job.id,
                error: null,
                requestedAt: createdAt,
                provider: 'notebooklm',
                format: 'deep_dive',
                notebookId: startFresh ? null : reference.podcast?.notebookId,
                sourceId: startFresh ? null : reference.podcast?.sourceId,
                artifactId: startFresh ? null : reference.podcast?.artifactId
            });
            context.log(`Podcast job ${job.id} queued for reference ${reference.id}`);
            return json(202, {
                success: true,
                reset: startFresh,
                jobId: job.id,
                podcast: podcastPayload(updatedReference, job)
            });
        } catch (error) {
            context.error('Create Reference Podcast Error:', error);
            return json(500, { error: 'Failed to create podcast job', details: error.message });
        }
    }
});

app.http('GetReferencePodcast', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'references/{id}/podcast',
    handler: async (request, context) => {
        if (!verifyDashboardRequest(request)) return unauthorized();
        try {
            let reference = await requireReference(request.params.id);
            if (!reference) return json(404, { error: 'Reference not found' });
            const job = await loadPodcastJob(reference);
            reference = await repairCompletedPodcastReference(reference, job, context);
            return json(200, { podcast: podcastPayload(reference, job) });
        } catch (error) {
            context.error('Get Reference Podcast Error:', error);
            return json(500, { error: 'Failed to load podcast status', details: error.message });
        }
    }
});

app.http('GetReferencePodcastAudio', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'references/{id}/podcast/audio',
    handler: async (request, context) => {
        if (!verifyDashboardRequest(request)) return unauthorized();
        try {
            let reference = await requireReference(request.params.id);
            if (!reference) return json(404, { error: 'Reference not found' });
            const job = await loadPodcastJob(reference);
            reference = await repairCompletedPodcastReference(reference, job, context);
            const podcast = reference.podcast;
            if (podcast?.status !== 'complete' || !podcast?.blobName) {
                return json(404, { error: 'Podcast audio is not available' });
            }
            const buffer = await downloadBlob(UPLOADS_CONTAINER, podcast.blobName);
            const download = request.query.get('download') === '1';
            const filename = safeFileName(podcast.fileName);
            return {
                status: 200,
                headers: {
                    'Content-Type': podcast.contentType || 'audio/mpeg',
                    'Content-Length': String(buffer.length),
                    'Cache-Control': 'private, max-age=3600',
                    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${filename}"`
                },
                body: buffer
            };
        } catch (error) {
            context.error('Get Reference Podcast Audio Error:', error);
            return json(500, { error: 'Failed to load podcast audio', details: error.message });
        }
    }
});

app.http('MarkReferencePodcastConsumed', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'references/{id}/podcast/consumed',
    handler: async (request, context) => {
        if (!verifyDashboardRequest(request)) return unauthorized();
        try {
            let reference = await requireReference(request.params.id);
            if (!reference) return json(404, { error: 'Reference not found' });
            const job = await loadPodcastJob(reference);
            reference = await repairCompletedPodcastReference(reference, job, context);
            if (reference.podcast?.status !== 'complete' || !reference.podcast?.blobName) {
                return json(409, { error: 'Podcast audio is not available' });
            }

            if (reference.podcast.consumedAt) {
                return json(200, {
                    success: true,
                    podcast: podcastPayload(reference),
                    alreadyConsumed: true
                });
            }

            const body = await request.json().catch(() => ({}));
            const method = body?.method === 'downloaded' ? 'downloaded' : 'played';
            const consumedAt = nowIso();
            const updatedReference = await updatePodcastReference(reference, {
                consumedAt,
                consumedMethod: method
            });
            return json(200, {
                success: true,
                podcast: podcastPayload(updatedReference),
                alreadyConsumed: false
            });
        } catch (error) {
            context.error('Mark Reference Podcast Consumed Error:', error);
            return json(500, { error: 'Failed to update podcast playback state', details: error.message });
        }
    }
});

app.http('ClaimPodcastJob', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'podcast-worker/claim',
    handler: async (request, context) => {
        if (!verifyWorkerRequest(request)) return unauthorized();
        try {
            const now = nowIso();
            const candidates = await queryItems(JOBS_CONTAINER, {
                query: `SELECT TOP 5 * FROM c
                        WHERE c.type = "podcast-generation"
                          AND (
                            c.status = "queued"
                            OR (
                                (c.status = "claimed" OR c.status = "processing" OR c.status = "generating" OR c.status = "uploading")
                                AND IS_DEFINED(c.leaseExpiresAt)
                                AND c.leaseExpiresAt < @now
                            )
                          )
                        ORDER BY c.createdAt ASC`,
                parameters: [{ name: '@now', value: now }]
            });
            const job = Array.isArray(candidates) ? candidates[0] : null;
            if (!job) return { status: 204 };

            const reference = await requireReference(job.referenceId);
            if (!reference) {
                await upsertItem(JOBS_CONTAINER, {
                    ...job,
                    status: 'error',
                    error: 'Reference no longer exists',
                    lastUpdated: now
                });
                return { status: 204 };
            }
            const pdf = findPdf(reference);
            if (!pdf) {
                const failedJob = {
                    ...job,
                    status: 'error',
                    error: 'Reference PDF is missing',
                    stage: 'Unable to start',
                    lastUpdated: now
                };
                await upsertItem(JOBS_CONTAINER, failedJob);
                await updatePodcastReference(reference, {
                    status: 'error',
                    error: failedJob.error,
                    stage: failedJob.stage
                });
                return { status: 204 };
            }

            const claimed = {
                ...job,
                status: 'claimed',
                progress: Math.max(Number(job.progress || 0), 5),
                stage: 'Laptop worker connected',
                claimedAt: now,
                lastUpdated: now,
                leaseExpiresAt: new Date(Date.now() + WORKER_LEASE_MS).toISOString(),
                attempts: Number(job.attempts || 0) + 1,
                error: null
            };
            await upsertItem(JOBS_CONTAINER, claimed);
            await updatePodcastReference(reference, {
                status: claimed.status,
                progress: claimed.progress,
                stage: claimed.stage,
                error: null
            });
            return json(200, {
                job: claimed,
                reference: {
                    id: reference.id,
                    title: reference.title || 'Research paper',
                    apa7: reference.apa7 || '',
                    pdf: {
                        name: pdf.name || pdf.fileName || 'paper.pdf',
                        blobName: pdf.blobName || extractBlobNameFromUrl(pdf.url, UPLOADS_CONTAINER)
                    }
                }
            });
        } catch (error) {
            context.error('Claim Podcast Job Error:', error);
            return json(500, { error: 'Failed to claim podcast job', details: error.message });
        }
    }
});

app.http('DownloadPodcastJobSource', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'podcast-worker/jobs/{jobId}/source',
    handler: async (request, context) => {
        if (!verifyWorkerRequest(request)) return unauthorized();
        try {
            const job = await getItem(JOBS_CONTAINER, request.params.jobId, request.params.jobId);
            if (!job || job.type !== 'podcast-generation') return json(404, { error: 'Job not found' });
            const reference = await requireReference(job.referenceId);
            const pdf = findPdf(reference);
            if (!pdf) return json(404, { error: 'Reference PDF is missing' });
            const blobName = pdf.blobName || extractBlobNameFromUrl(pdf.url, UPLOADS_CONTAINER);
            if (!blobName) return json(400, { error: 'Could not resolve source PDF blob' });
            const buffer = await downloadBlob(UPLOADS_CONTAINER, blobName);
            return {
                status: 200,
                headers: {
                    'Content-Type': 'application/pdf',
                    'Content-Length': String(buffer.length),
                    'Content-Disposition': `attachment; filename="${safeFileName(pdf.name || pdf.fileName, 'paper.pdf')}"`
                },
                body: buffer
            };
        } catch (error) {
            context.error('Download Podcast Job Source Error:', error);
            return json(500, { error: 'Failed to download source PDF', details: error.message });
        }
    }
});

app.http('UpdatePodcastJobProgress', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'podcast-worker/jobs/{jobId}/progress',
    handler: async (request, context) => {
        if (!verifyWorkerRequest(request)) return unauthorized();
        try {
            const job = await getItem(JOBS_CONTAINER, request.params.jobId, request.params.jobId);
            if (!job || job.type !== 'podcast-generation') return json(404, { error: 'Job not found' });
            const body = await request.json();
            const allowedStatuses = new Set(['claimed', 'processing', 'generating', 'uploading', 'error']);
            const status = allowedStatuses.has(body?.status) ? body.status : job.status;
            const progress = Math.max(0, Math.min(99, Number(body?.progress ?? job.progress ?? 0)));
            const updatedJob = {
                ...job,
                status,
                progress,
                stage: (body?.stage || job.stage || '').toString().slice(0, 200),
                notebookId: body?.notebookId || job.notebookId || null,
                sourceId: body?.sourceId || job.sourceId || null,
                artifactId: body?.artifactId || job.artifactId || null,
                error: status === 'error' ? (body?.error || 'Podcast generation failed').toString().slice(0, 2000) : null,
                lastUpdated: nowIso(),
                leaseExpiresAt: new Date(Date.now() + WORKER_LEASE_MS).toISOString()
            };
            if (status === 'error') updatedJob.completedAt = nowIso();
            await upsertItem(JOBS_CONTAINER, updatedJob);

            const reference = await requireReference(job.referenceId);
            if (reference) {
                await updatePodcastReference(reference, {
                    status,
                    progress,
                    stage: updatedJob.stage,
                    error: updatedJob.error,
                    notebookId: updatedJob.notebookId,
                    sourceId: updatedJob.sourceId,
                    artifactId: updatedJob.artifactId
                });
            }
            return json(200, { success: true, job: updatedJob });
        } catch (error) {
            context.error('Update Podcast Job Progress Error:', error);
            return json(500, { error: 'Failed to update podcast job', details: error.message });
        }
    }
});

app.http('UploadPodcastJobAudio', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'podcast-worker/jobs/{jobId}/upload',
    handler: async (request, context) => {
        if (!verifyWorkerRequest(request)) return unauthorized();
        try {
            const job = await getItem(JOBS_CONTAINER, request.params.jobId, request.params.jobId);
            if (!job || job.type !== 'podcast-generation') return json(404, { error: 'Job not found' });
            const reference = await requireReference(job.referenceId);
            if (!reference) return json(404, { error: 'Reference not found' });

            const body = await request.json();
            if (!body?.fileData) return json(400, { error: 'fileData is required' });
            const buffer = Buffer.from(body.fileData, 'base64');
            if (!buffer.length) return json(400, { error: 'Audio file is empty' });
            if (buffer.length > MAX_AUDIO_BYTES) {
                return json(413, { error: `Audio exceeds the ${MAX_AUDIO_BYTES} byte upload limit` });
            }

            const contentType = ['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a']
                .includes((body.contentType || '').toLowerCase())
                ? body.contentType.toLowerCase()
                : 'audio/mpeg';
            const extension = contentType.includes('mp4') || contentType.includes('m4a') ? 'm4a' : 'mp3';
            const fileName = safeFileName(body.fileName, `audio-overview.${extension}`);
            const blobName = `podcasts/${reference.id}/audio-overview-${Date.now()}.${extension}`;
            const url = await uploadBlob(UPLOADS_CONTAINER, blobName, buffer, contentType);

            const previousBlob = reference.podcast?.blobName;
            const completedAt = nowIso();
            const updatedReference = await updatePodcastReference(reference, {
                status: 'complete',
                progress: 100,
                stage: 'Podcast ready',
                error: null,
                provider: 'notebooklm',
                format: 'deep_dive',
                jobId: job.id,
                notebookId: body.notebookId || job.notebookId || null,
                sourceId: body.sourceId || job.sourceId || null,
                artifactId: body.artifactId || job.artifactId || null,
                blobName,
                url,
                fileName,
                contentType,
                sizeBytes: buffer.length,
                completedAt,
                consumedAt: null,
                consumedMethod: null
            });
            const completedJob = {
                ...job,
                status: 'complete',
                progress: 100,
                stage: 'Podcast ready',
                blobName,
                audioUrl: url,
                fileName,
                contentType,
                sizeBytes: buffer.length,
                notebookId: updatedReference.podcast.notebookId,
                sourceId: updatedReference.podcast.sourceId,
                artifactId: updatedReference.podcast.artifactId,
                lastUpdated: completedAt,
                completedAt,
                leaseExpiresAt: null,
                error: null
            };
            await upsertItem(JOBS_CONTAINER, completedJob);

            if (previousBlob && previousBlob !== blobName) {
                try {
                    await deleteBlob(UPLOADS_CONTAINER, previousBlob);
                } catch (cleanupError) {
                    context.warn(`Could not remove replaced podcast blob ${previousBlob}: ${cleanupError.message}`);
                }
            }
            return json(200, {
                success: true,
                podcast: podcastPayload(updatedReference, completedJob)
            });
        } catch (error) {
            context.error('Upload Podcast Job Audio Error:', error);
            return json(500, { error: 'Failed to upload podcast audio', details: error.message });
        }
    }
});
