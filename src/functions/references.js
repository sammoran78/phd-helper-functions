const { app } = require('@azure/functions');
const { queryItems, createItem, getItem, upsertItem, deleteItem } = require('../../shared/cosmosClient');
const { deleteBlob, blobExists } = require('../../shared/blobClient');
const { Document, Packer, Paragraph, TextRun } = require('docx');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const OpenAI = require('openai');

const CONTAINER_NAME = process.env.COSMOSDB_CONTAINER_REFERENCES || 'references';
const CONTAINER_PAGES = process.env.COSMOSDB_CONTAINER_PAGES || 'pages';
const CONTAINER_JOBS = process.env.COSMOSDB_CONTAINER_JOBS || 'jobs';
const SHORTLIST_CONTAINER = process.env.COSMOSDB_CONTAINER_ANALYTICS || 'analytics';
const SHORTLIST_ID = 'shortlist';
const BLOB_CONTAINER_UPLOADS = process.env.BLOB_CONTAINER_UPLOADS || 'uploads';
const BLOB_CONTAINER_PAGES = process.env.BLOB_CONTAINER_PAGES || 'pages';
const BIBLIOGRAPHY_FILTER_CLAUSE = 'c.ref_knowledge_status >= 3 AND (NOT IS_DEFINED(c.dismissed) OR c.dismissed != true)';
const BIBLIOGRAPHY_EXPORT_QUERY = `SELECT c.id, c.authors, c.author, c.year, c.title, c.apa7, c.journal, c.source, c.publisher, c.doi, c.url, c.link FROM c WHERE ${BIBLIOGRAPHY_FILTER_CLAUSE}`;
const DOCX_EXPORT_MAX_ITEMS = Number(process.env.BIBLIOGRAPHY_DOCX_MAX_ITEMS || 400);
const JOB_TTL_SECONDS = 7200;

let openaiClient = null;

const getOpenAiClient = () => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return null;
    if (!openaiClient) {
        openaiClient = new OpenAI({ apiKey });
    }
    return openaiClient;
};

const wrapRichTextSegments = (segments, maxWidth, getFont, fontSize) => {
    const lines = [];
    let currentLine = [];
    let currentWidth = 0;

    const pushLine = () => {
        if (currentLine.length === 0) return;
        while (currentLine.length > 0 && /^\s+$/.test(currentLine[currentLine.length - 1].text)) {
            currentLine.pop();
        }
        if (currentLine.length > 0) lines.push(currentLine);
        currentLine = [];
        currentWidth = 0;
    };

    segments.forEach(segment => {
        const parts = (segment.text || '').split(/(\s+)/).filter(Boolean);
        parts.forEach(part => {
            const isWhitespace = /^\s+$/.test(part);
            if (isWhitespace && currentLine.length === 0) return;

            const font = getFont(segment);
            const width = font.widthOfTextAtSize(part, fontSize);

            if (!isWhitespace && currentLine.length > 0 && currentWidth + width > maxWidth) {
                pushLine();
            }

            if (isWhitespace && currentLine.length === 0) return;

            currentLine.push({ ...segment, text: part, font });
            currentWidth += width;
        });
    });

    pushLine();
    return lines;
};

const normalizeValue = (value) => (value || '').toString().trim().toLowerCase();

const normalizeSortKey = (value) => {
    const s = (value || '').toString();
    return s
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[\u200B\u200E\u200F\uFEFF]/g, '')
        .trim()
        .toLowerCase();
};

const extractPrimaryAuthorToken = (reference) => {
    // Prioritize the explicit authors/author field
    let s = (reference?.authors || reference?.author || '').toString().trim();
    
    // If no authors field, try to extract from apa7 citation (format: "Author. (Year). Title...")
    if (!s) {
        const apa7 = (reference?.apa7 || '').toString();
        // Match author pattern at the start: everything before the year in parens
        const match = apa7.match(/^([^.]+\.\s+)?\(/);
        if (match) {
            s = apa7.slice(0, match.index).trim();
        }
    }
    
    if (!s) return '';

    // Remove leading non-alphabetic characters
    s = s.replace(/^[^A-Za-z]+/g, '').trim();

    // For "Surname, Initials & Surname, Initials" format - keep first author only
    // Split on & first to get just the first author
    s = s.split(/\s+&\s+/)[0].trim();
    
    // Split on comma to get just the surname (handles "Surname, A." format)
    const commaIdx = s.indexOf(',');
    if (commaIdx > 0) {
        s = s.slice(0, commaIdx).trim();
    }

    // Clean up any remaining punctuation
    s = s.replace(/[.\s]+$/g, '').trim();
    
    return s;
};

const getBibliographySortKey = (reference) => {
    // Sort by the full APA7 citation text character-by-character
    const apa7Key = normalizeSortKey(reference?.apa7);
    if (apa7Key) return apa7Key;

    // Fallback: sort by authors then title
    const authorKey = normalizeSortKey(reference?.authors || reference?.author);
    if (authorKey) return authorKey;

    const titleKey = normalizeSortKey(reference?.title);
    if (titleKey) return titleKey;

    return normalizeSortKey(reference?.id);
};

const sortBibliographyReferences = (references) => {
    const list = Array.isArray(references) ? references : [];
    return list.sort((a, b) => {
        const keyA = getBibliographySortKey(a);
        const keyB = getBibliographySortKey(b);
        const cmp = keyA.localeCompare(keyB, undefined, { sensitivity: 'base' });
        if (cmp !== 0) return cmp;

        const titleA = normalizeSortKey(a?.title);
        const titleB = normalizeSortKey(b?.title);
        const tcmp = titleA.localeCompare(titleB, undefined, { sensitivity: 'base' });
        if (tcmp !== 0) return tcmp;

        return normalizeSortKey(a?.id).localeCompare(normalizeSortKey(b?.id));
    });
};

const getReferenceKeys = (reference) => {
    const doiKey = normalizeValue(reference?.doi);
    const titleKey = normalizeValue(reference?.title);
    return { doiKey, titleKey };
};

const removeFromShortlistByKeys = async (doiKey, titleKey, context) => {
    if (!doiKey && !titleKey) return;
    const shortlistDoc = await getItem(SHORTLIST_CONTAINER, SHORTLIST_ID, SHORTLIST_ID);
    if (!shortlistDoc || !Array.isArray(shortlistDoc.articles)) return;

    const filtered = shortlistDoc.articles.filter(article => {
        const articleDoiKey = normalizeValue(article?.doiKey || article?.doi);
        const articleTitleKey = normalizeValue(article?.titleKey || article?.title);
        if (doiKey && articleDoiKey === doiKey) return false;
        if (titleKey && articleTitleKey === titleKey) return false;
        return true;
    });

    if (filtered.length !== shortlistDoc.articles.length) {
        shortlistDoc.articles = filtered;
        await upsertItem(SHORTLIST_CONTAINER, shortlistDoc);
        context?.log('Removed reference from shortlist');
    }
};

const extractBlobNameFromUrl = (url, containerName) => {
    const raw = (url || '').toString().trim();
    if (!raw) return '';
    try {
        const parsed = new URL(raw);
        const pathParts = parsed.pathname.split('/').filter(Boolean);
        const containerIndex = pathParts.indexOf(containerName);
        if (containerIndex >= 0) {
            return pathParts.slice(containerIndex + 1).join('/');
        }
        return pathParts.slice(1).join('/');
    } catch {
        const parts = raw.split('/').filter(Boolean);
        const containerIndex = parts.indexOf(containerName);
        if (containerIndex >= 0) {
            return parts.slice(containerIndex + 1).join('/');
        }
        return parts[parts.length - 1] || '';
    }
};

const deleteBlobIfPresent = async (containerName, blobName, failures, kind, targetId) => {
    const normalized = (blobName || '').toString().trim();
    if (!normalized) return false;
    try {
        await deleteBlob(containerName, normalized);
        return true;
    } catch (error) {
        const message = error?.message || String(error);
        if (!/not found/i.test(message) && error?.statusCode !== 404 && error?.code !== 404) {
            failures.push({ stage: kind, targetId, message });
        }
        return false;
    }
};

const buildDeleteJobProgress = (job) => {
    const totalSteps = Number(job?.totalSteps || 0);
    const stepsCompleted = Number(job?.stepsCompleted || 0);
    return totalSteps > 0 ? Math.round((stepsCompleted / totalSteps) * 100) : 0;
};

const updateDeleteJob = async (jobRecord, patch = {}) => {
    const next = {
        ...jobRecord,
        ...patch,
        lastUpdated: new Date().toISOString()
    };
    if (!next.ttl) next.ttl = JOB_TTL_SECONDS;
    await upsertItem(CONTAINER_JOBS, next);
    return next;
};

const buildDeleteJobRecord = (referenceId) => ({
    id: `job_${referenceId}_delete_${Date.now()}`,
    referenceId,
    type: 'delete-reference',
    status: 'initializing',
    totalSteps: 5,
    stepsCompleted: 0,
    currentStep: 0,
    currentStepLabel: 'Preparing rollback plan',
    progress: 0,
    stepResults: [],
    error: null,
    startedAt: new Date().toISOString(),
    ttl: JOB_TTL_SECONDS
});

const runDeleteStep = async (jobRecord, stepNumber, label, runStep) => {
    let nextJob = await updateDeleteJob(jobRecord, {
        status: 'processing',
        currentStep: stepNumber,
        currentStepLabel: label,
        progress: buildDeleteJobProgress(jobRecord)
    });

    const outcome = await runStep();
    const result = {
        step: stepNumber,
        label,
        ok: !(Array.isArray(outcome?.failures) && outcome.failures.length > 0),
        failures: Array.isArray(outcome?.failures) ? outcome.failures : [],
        stats: outcome?.stats || {}
    };

    nextJob = await updateDeleteJob(nextJob, {
        stepsCompleted: stepNumber,
        progress: Math.round((stepNumber / (nextJob.totalSteps || 1)) * 100),
        stepResults: [...(Array.isArray(nextJob.stepResults) ? nextJob.stepResults : []), result]
    });

    if (!result.ok) {
        const error = new Error(`Rollback stopped at step ${stepNumber}: ${label}`);
        error.details = result;
        throw error;
    }

    return nextJob;
};

const buildVerificationSummary = async (reference, pageList, files) => {
    const vectorStoreIds = [];
    const openAiFileIds = [];
    for (const page of pageList) {
        if (page?.openaiVector?.vectorStoreFileId) vectorStoreIds.push(page.openaiVector.vectorStoreFileId);
        if (page?.openaiVector?.fileId) openAiFileIds.push(page.openaiVector.fileId);
    }

    const pageBlobChecks = await Promise.all(pageList.map(async (page) => {
        const blobName = page?.blobName || extractBlobNameFromUrl(page?.blobUrl, BLOB_CONTAINER_PAGES);
        if (!blobName) return { id: page?.id, verified: true };
        try {
            const exists = await blobExists(BLOB_CONTAINER_PAGES, blobName);
            return { id: page?.id, verified: !exists };
        } catch {
            return { id: page?.id, verified: false };
        }
    }));

    const uploadBlobChecks = await Promise.all(files.map(async (file) => {
        const blobName = file?.blobName || extractBlobNameFromUrl(file?.url, BLOB_CONTAINER_UPLOADS);
        if (!blobName) return { id: file?.name || file?.url || reference.id, verified: true };
        try {
            const exists = await blobExists(BLOB_CONTAINER_UPLOADS, blobName);
            return { id: file?.name || blobName, verified: !exists };
        } catch {
            return { id: file?.name || blobName, verified: false };
        }
    }));

    const pageRecordChecks = await Promise.all(pageList.map(async (page) => {
        try {
            const item = await getItem(CONTAINER_PAGES, page.id, page.id);
            return { id: page.id, verified: !item };
        } catch {
            return { id: page.id, verified: false };
        }
    }));

    let referenceMissing = false;
    try {
        const remainingReference = await getItem(CONTAINER_NAME, reference.id, reference.id);
        referenceMissing = !remainingReference;
    } catch {
        referenceMissing = false;
    }

    return {
        vectorStoreEntriesRemoved: vectorStoreIds.length,
        openAiFilesRemoved: openAiFileIds.length,
        pageBlobsVerifiedRemoved: pageBlobChecks.filter(item => item.verified).length,
        uploadBlobsVerifiedRemoved: uploadBlobChecks.filter(item => item.verified).length,
        pageRecordsVerifiedRemoved: pageRecordChecks.filter(item => item.verified).length,
        referenceVerifiedRemoved: referenceMissing,
        allChecksPassed: pageBlobChecks.every(item => item.verified)
            && uploadBlobChecks.every(item => item.verified)
            && pageRecordChecks.every(item => item.verified)
            && referenceMissing
    };
};

const processDeleteReferenceJob = async (jobRecord, context) => {
    let currentJob = jobRecord;
    try {
        const reference = await getItem(CONTAINER_NAME, jobRecord.referenceId, jobRecord.referenceId);
        if (!reference) {
            await updateDeleteJob(currentJob, {
                status: 'error',
                currentStepLabel: 'Reference not found',
                error: 'Reference not found',
                completedAt: new Date().toISOString(),
                progress: buildDeleteJobProgress(currentJob)
            });
            return;
        }

        const pages = await queryItems(CONTAINER_PAGES, {
            query: 'SELECT * FROM c WHERE c.referenceId = @referenceId ORDER BY c.pageNumber',
            parameters: [{ name: '@referenceId', value: reference.id }]
        });
        const pageList = Array.isArray(pages) ? pages : [];
        const files = Array.isArray(reference.files) ? [...reference.files] : [];
        if (reference?.podcast?.blobName || reference?.podcast?.url) {
            files.push({
                name: reference.podcast.fileName || 'audio-overview.mp3',
                blobName: reference.podcast.blobName,
                url: reference.podcast.url,
                contentType: reference.podcast.contentType || 'audio/mpeg'
            });
        }
        const openai = getOpenAiClient();
        const { doiKey, titleKey } = getReferenceKeys(reference);

        currentJob = await runDeleteStep(currentJob, 1, 'Removing vector store entries and OpenAI files', async () => {
            const failures = [];
            const stats = { vectorStoreEntriesDeleted: 0, openAiFilesDeleted: 0, pagesFound: pageList.length };

            for (const page of pageList) {
                const vectorStoreId = page?.openaiVector?.vectorStoreId || reference?.kb_vector_store_id || process.env.OPENAI_VECTOR_STORE;
                const vectorStoreFileId = page?.openaiVector?.vectorStoreFileId;
                const fileId = page?.openaiVector?.fileId;

                if (openai && vectorStoreId && vectorStoreFileId) {
                    try {
                        await openai.vectorStores.files.del(vectorStoreId, vectorStoreFileId);
                        stats.vectorStoreEntriesDeleted += 1;
                    } catch (error) {
                        const message = error?.message || String(error);
                        if (!/not found/i.test(message) && error?.status !== 404 && error?.statusCode !== 404) {
                            failures.push({ stage: 'vector_store_file', targetId: vectorStoreFileId, message });
                        }
                    }
                }

                if (openai && fileId) {
                    try {
                        await openai.files.del(fileId);
                        stats.openAiFilesDeleted += 1;
                    } catch (error) {
                        const message = error?.message || String(error);
                        if (!/not found/i.test(message) && error?.status !== 404 && error?.statusCode !== 404) {
                            failures.push({ stage: 'openai_file', targetId: fileId, message });
                        }
                    }
                }
            }

            return { failures, stats };
        });

        currentJob = await runDeleteStep(currentJob, 2, 'Deleting split page blobs from storage', async () => {
            const failures = [];
            const stats = { pageBlobsDeleted: 0, pagesFound: pageList.length };

            for (const page of pageList) {
                const deletedBlob = await deleteBlobIfPresent(
                    BLOB_CONTAINER_PAGES,
                    page?.blobName || extractBlobNameFromUrl(page?.blobUrl, BLOB_CONTAINER_PAGES),
                    failures,
                    'page_blob',
                    page?.id
                );
                if (deletedBlob) stats.pageBlobsDeleted += 1;
            }

            return { failures, stats };
        });

        currentJob = await runDeleteStep(currentJob, 3, 'Deleting uploaded source documents from storage', async () => {
            const failures = [];
            const stats = { uploadBlobsDeleted: 0, filesFound: files.length };

            for (const file of files) {
                const deletedBlob = await deleteBlobIfPresent(
                    BLOB_CONTAINER_UPLOADS,
                    file?.blobName || extractBlobNameFromUrl(file?.url, BLOB_CONTAINER_UPLOADS),
                    failures,
                    'upload_blob',
                    file?.blobName || file?.url || file?.name || reference.id
                );
                if (deletedBlob) stats.uploadBlobsDeleted += 1;
            }

            return { failures, stats };
        });

        currentJob = await runDeleteStep(currentJob, 4, 'Deleting page records from CosmosDB', async () => {
            const failures = [];
            const stats = { pageRecordsDeleted: 0, pagesFound: pageList.length };

            for (const page of pageList) {
                try {
                    await deleteItem(CONTAINER_PAGES, page.id, page.id);
                    stats.pageRecordsDeleted += 1;
                } catch (error) {
                    failures.push({ stage: 'page_record', targetId: page?.id, message: error?.message || String(error) });
                }
            }

            return { failures, stats };
        });

        currentJob = await runDeleteStep(currentJob, 5, 'Deleting reference record from CosmosDB', async () => {
            const failures = [];
            const stats = { referenceDeleted: 0, shortlistUpdated: 0 };

            try {
                await removeFromShortlistByKeys(doiKey, titleKey, context);
                stats.shortlistUpdated = 1;
            } catch (error) {
                failures.push({ stage: 'shortlist_cleanup', targetId: reference.id, message: error?.message || String(error) });
            }

            if (failures.length === 0) {
                try {
                    await deleteItem(CONTAINER_NAME, reference.id, reference.id);
                    stats.referenceDeleted = 1;
                } catch (error) {
                    failures.push({ stage: 'reference_record', targetId: reference.id, message: error?.message || String(error) });
                }
            }

            return { failures, stats };
        });

        const verification = await buildVerificationSummary(reference, pageList, files);

        await updateDeleteJob(currentJob, {
            status: 'complete',
            currentStep: currentJob.totalSteps,
            currentStepLabel: 'Deletion complete',
            progress: 100,
            completedAt: new Date().toISOString(),
            error: null,
            verification
        });
    } catch (error) {
        await updateDeleteJob(currentJob, {
            status: 'error',
            currentStepLabel: currentJob.currentStepLabel || 'Deletion failed',
            progress: buildDeleteJobProgress(currentJob),
            completedAt: new Date().toISOString(),
            error: error?.message || String(error)
        });
        context?.error?.('Delete Reference Job Error:', error);
    }
};

// GET /api/references - Get all references
app.http('GetReferences', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'references',
    handler: async (request, context) => {
        try {
            context.log('Loading references from CosmosDB');
            
            const querySpec = {
                query: 'SELECT * FROM c WHERE (NOT IS_DEFINED(c.dismissed) OR c.dismissed != true) ORDER BY c._ts DESC'
            };
            
            const references = await queryItems(CONTAINER_NAME, querySpec);
            
            context.log(`Loaded ${references.length} references`);
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(references)
            };
        } catch (error) {
            context.error('Get References Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to load references', details: error.message })
            };
        }
    }
});

// POST /api/references/delete-job/{jobId}/run - Execute a reference deletion job
app.http('RunDeleteReferenceJob', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'references/delete-job/{jobId}/run',
    handler: async (request, context) => {
        try {
            const jobId = request.params.jobId;
            const job = await getItem(CONTAINER_JOBS, jobId, jobId);
            if (!job) {
                return {
                    status: 404,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Job not found' })
                };
            }

            if (job.type !== 'delete-reference') {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Job is not a reference deletion job' })
                };
            }

            if (job.status === 'processing') {
                return {
                    status: 202,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ success: true, message: 'Delete job already running', jobId })
                };
            }

            if (job.status === 'complete') {
                return {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ success: true, message: 'Delete job already complete', jobId })
                };
            }

            await processDeleteReferenceJob(job, context);
            return {
                status: 202,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true, message: 'Delete job started', jobId })
            };
        } catch (error) {
            context.error('Run Delete Reference Job Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to run delete job', details: error.message })
            };
        }
    }
});

// GET /api/references/delete-job/{jobId} - Get reference deletion job status
app.http('GetDeleteReferenceJob', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'references/delete-job/{jobId}',
    handler: async (request, context) => {
        try {
            const jobId = request.params.jobId;
            const job = await getItem(CONTAINER_JOBS, jobId, jobId);
            if (!job) {
                return {
                    status: 404,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Job not found' })
                };
            }

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jobId: job.id,
                    referenceId: job.referenceId,
                    type: job.type,
                    status: job.status,
                    totalSteps: job.totalSteps || 0,
                    stepsCompleted: job.stepsCompleted || 0,
                    currentStep: job.currentStep || 0,
                    currentStepLabel: job.currentStepLabel || '',
                    progress: typeof job.progress === 'number' ? job.progress : buildDeleteJobProgress(job),
                    stepResults: Array.isArray(job.stepResults) ? job.stepResults : [],
                    verification: job.verification || null,
                    startedAt: job.startedAt,
                    completedAt: job.completedAt,
                    error: job.error || null
                })
            };
        } catch (error) {
            context.error('Get Delete Reference Job Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to get delete job status', details: error.message })
            };
        }
    }
});

// GET /api/references/bibliography/export-pdf - Export bibliography list as PDF
app.http('ExportBibliographyPdf', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'references/bibliography/export-pdf',
    handler: async (request, context) => {
        try {
            context.log('Exporting bibliography to PDF');

            const references = await queryItems(CONTAINER_NAME, {
                query: BIBLIOGRAPHY_EXPORT_QUERY
            });

            const sorted = sortBibliographyReferences(references);

            const pdfDoc = await PDFDocument.create();
            const font = await pdfDoc.embedFont(StandardFonts.TimesRoman);
            const boldFont = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
            const italicFont = await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);
            const boldItalicFont = await pdfDoc.embedFont(StandardFonts.TimesRomanBoldItalic);
            const fontSize = 12;
            const lineHeight = 16;
            const margin = 54;
            const hangingIndent = 24;
            const pageWidth = 612;
            const pageHeight = 792;

            let page = pdfDoc.addPage([pageWidth, pageHeight]);
            let y = pageHeight - margin;

            const getFontForSegment = (segment) => {
                if (segment.bold && segment.italics) return boldItalicFont;
                if (segment.bold) return boldFont;
                if (segment.italics) return italicFont;
                return font;
            };

            sorted.forEach(ref => {
                const sourceText = buildExportCitationText(ref, { useHtmlStrip: true, maxChars: 1800 });
                const segments = parseSimpleMarkdownSegments(sourceText)
                    .map(segment => ({ ...segment, text: sanitizePdfText(segment.text) }))
                    .filter(segment => segment.text);
                const lines = wrapRichTextSegments(segments, pageWidth - margin * 2 - hangingIndent, getFontForSegment, fontSize);

                if (y - lines.length * lineHeight < margin) {
                    page = pdfDoc.addPage([pageWidth, pageHeight]);
                    y = pageHeight - margin;
                }

                lines.forEach((line, lineIdx) => {
                    let x = margin + (lineIdx === 0 ? 0 : hangingIndent);
                    line.forEach(run => {
                        page.drawText(run.text, {
                            x,
                            y,
                            size: fontSize,
                            font: run.font || font,
                            color: rgb(0.1, 0.1, 0.1)
                        });
                        x += (run.font || font).widthOfTextAtSize(run.text, fontSize);
                    });
                    y -= lineHeight;
                });

                y -= 8;
            });

            if (sorted.length === 0) {
                page.drawText('No bibliography entries.', {
                    x: margin,
                    y,
                    size: fontSize,
                    font,
                    color: rgb(0.1, 0.1, 0.1)
                });
            }

            const pdfBytes = await pdfDoc.save();
            const fileName = `bibliography_${new Date().toISOString().slice(0, 10)}.pdf`;

            return {
                status: 200,
                isRaw: true,
                headers: {
                    'Content-Type': 'application/pdf',
                    'Content-Disposition': `attachment; filename="${fileName}"`
                },
                body: Buffer.from(pdfBytes)
            };
        } catch (error) {
            context.error('Export Bibliography PDF Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to export bibliography', details: error.message })
            };
        }
    }
});

// GET /api/references/bibliography/export-bibtex - Export bibliography list as BibTeX
app.http('ExportBibliographyBibtex', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'references/bibliography/export-bibtex',
    handler: async (request, context) => {
        try {
            context.log('Exporting bibliography to BibTeX');

            const enrichMode = (request?.query?.get('enrich') || 'auto').toLowerCase();
            const useLlmEnrichment = enrichMode !== 'off';

            const references = await queryItems(CONTAINER_NAME, {
                query: BIBLIOGRAPHY_EXPORT_QUERY
            });

            const sorted = sortBibliographyReferences(references);
            const metadata = await enrichBibtexMetadataWithLlm(sorted, context, useLlmEnrichment);
            const entries = sorted.map((ref, idx) => formatBibtexEntry(ref, metadata[idx]));
            const content = entries.length > 0 ? `${entries.join('\n\n')}\n` : '';
            const fileName = `bibliography_${new Date().toISOString().slice(0, 10)}.bib`;

            return {
                status: 200,
                headers: {
                    'Content-Type': 'application/x-bibtex; charset=utf-8',
                    'Content-Disposition': `attachment; filename="${fileName}"`
                },
                body: content
            };
        } catch (error) {
            context.error('Export Bibliography BibTeX Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to export bibliography', details: error.message })
            };
        }
    }
});

// POST /api/references - Create a new reference
app.http('CreateReference', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'references',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            
            const newReference = {
                id: `ref_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                ...body,
                dateAdded: new Date().toISOString()
            };
            
            const created = await createItem(CONTAINER_NAME, newReference);

            const { doiKey, titleKey } = getReferenceKeys(created);
            await removeFromShortlistByKeys(doiKey, titleKey, context);
            
            context.log(`Created reference: ${created.id}`);
            
            return {
                status: 201,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(created)
            };
        } catch (error) {
            context.error('Create Reference Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to create reference', details: error.message })
            };
        }
    }
});

// PUT /api/references/{id} - Update a reference
app.http('UpdateReference', {
    methods: ['PUT'],
    authLevel: 'anonymous',
    route: 'references/{id}',
    handler: async (request, context) => {
        try {
            const id = request.params.id;
            const body = await request.json();
            
            const existing = await getItem(CONTAINER_NAME, id, id);
            if (!existing) {
                return {
                    status: 404,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Reference not found' })
                };
            }
            
            const updatedReference = {
                ...existing,
                ...body,
                id: id,
                dateModified: new Date().toISOString()
            };
            
            const updated = await upsertItem(CONTAINER_NAME, updatedReference);

            const existingKeys = getReferenceKeys(existing);
            const updatedKeys = getReferenceKeys(updatedReference);
            await removeFromShortlistByKeys(existingKeys.doiKey, existingKeys.titleKey, context);
            await removeFromShortlistByKeys(updatedKeys.doiKey, updatedKeys.titleKey, context);
            
            context.log(`Updated reference: ${id}`);
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updated)
            };
        } catch (error) {
            context.error('Update Reference Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to update reference', details: error.message })
            };
        }
    }
});

// GET /api/references/bibliography - Get references with ref_knowledge_status>=3 for bibliography
app.http('GetBibliography', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'references/bibliography',
    handler: async (request, context) => {
        try {
            context.log('Loading bibliography references (status>=3) from CosmosDB');
            
            const querySpec = {
                query: 'SELECT * FROM c WHERE c.ref_knowledge_status >= 3 AND (NOT IS_DEFINED(c.dismissed) OR c.dismissed != true)'
            };
            
            const references = await queryItems(CONTAINER_NAME, querySpec);

            const sorted = sortBibliographyReferences(references);
            
            context.log(`Loaded ${sorted.length} bibliography references`);
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(sorted)
            };
        } catch (error) {
            context.error('Get Bibliography Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to load bibliography', details: error.message })
            };
        }
    }
});

function parseSimpleMarkdownRuns(text) {
    return parseSimpleMarkdownSegments(text).map(segment => new TextRun({
        text: segment.text,
        font: 'Times New Roman',
        size: 22,
        bold: !!segment.bold,
        italics: !!segment.italics
    }));
}

function parseSimpleMarkdownSegments(text) {
    const s = (text || '').toString();
    const segments = [];
    let i = 0;

    const pushSegment = (value, opts) => {
        if (!value) return;
        segments.push({
            text: value,
            bold: !!opts?.bold,
            italics: !!opts?.italics
        });
    };

    while (i < s.length) {
        const isBold = s.startsWith('**', i);
        const isItalic = s.startsWith('*', i);

        if (isBold) {
            const end = s.indexOf('**', i + 2);
            if (end !== -1) {
                pushSegment(s.slice(i + 2, end), { bold: true });
                i = end + 2;
                continue;
            }

            // Unmatched bold marker: treat as literal to ensure forward progress
            pushSegment('**', {});
            i += 2;
            continue;
        }

        if (isItalic) {
            const end = s.indexOf('*', i + 1);
            if (end !== -1) {
                pushSegment(s.slice(i + 1, end), { italics: true });
                i = end + 1;
                continue;
            }

            // Unmatched italic marker: treat as literal to ensure forward progress
            pushSegment('*', {});
            i += 1;
            continue;
        }

        const nextBold = s.indexOf('**', i);
        const nextItalic = s.indexOf('*', i);
        let next = -1;
        if (nextBold !== -1 && nextItalic !== -1) next = Math.min(nextBold, nextItalic);
        else next = nextBold !== -1 ? nextBold : nextItalic;

        if (next === -1) {
            pushSegment(s.slice(i), {});
            break;
        }

        if (next <= i) {
            // Safety guard against non-advancing cursor on malformed marker patterns
            pushSegment(s.charAt(i), {});
            i += 1;
            continue;
        }

        pushSegment(s.slice(i, next), {});
        i = next;
    }

    return segments;
}

const stripApaFormatting = (text) => (text || '')
    .toString()
    .replace(/<[^>]+>/g, ' ')
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const stripApaHtml = (text) => (text || '')
    .toString()
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const sanitizeDocxText = (text) => (text || '')
    .toString()
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const sanitizePdfText = (text) => (text || '')
    .toString()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '');

const buildExportCitationText = (reference, options = {}) => {
    const maxChars = Number(options.maxChars || 1800);
    const useHtmlStrip = !!options.useHtmlStrip;
    const useMarkdownStrip = !!options.useMarkdownStrip;

    const apa7 = (reference?.apa7 || '').toString().trim();
    const fallback = `${reference?.authors || reference?.author || 'Unknown Author'} (${reference?.year || 'n.d.'}). ${reference?.title || 'Untitled'}.`;
    let text = apa7 || fallback;

    if (useHtmlStrip) text = stripApaHtml(text);
    if (useMarkdownStrip) text = stripApaFormatting(text);

    text = (text || '').toString().replace(/\s+/g, ' ').trim();
    if (text.length > maxChars) {
        text = `${text.slice(0, maxChars)}…`;
    }
    return text;
};

const wrapText = (text, maxWidth, font, fontSize) => {
    const words = (text || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let current = '';
    for (const word of words) {
        const next = current ? `${current} ${word}` : word;
        const width = font.widthOfTextAtSize(next, fontSize);
        if (width <= maxWidth) {
            current = next;
        } else {
            if (current) lines.push(current);
            current = word;
        }
    }
    if (current) lines.push(current);
    return lines;
};

const buildBibtexKey = (reference) => {
    const author = (reference?.authors || reference?.author || 'ref').toString().split(/[,;&]/)[0].trim();
    const year = (reference?.year || 'n.d.').toString().replace(/[^0-9]/g, '') || 'nd';
    const title = (reference?.title || 'untitled').toString().split(/\s+/)[0];
    const raw = `${author}${year}${title}`.toLowerCase();
    return raw.replace(/[^a-z0-9]+/g, '').slice(0, 40) || `ref${Date.now()}`;
};

const cleanBibtexValue = (value) => (value || '')
    .toString()
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[{}]/g, '')
    .trim();

const parseBibtexNumericMetadata = (text) => {
    const s = stripApaFormatting(text);

    const volumeIssue = s.match(/\b(\d{1,4})\s*\(([^)]+)\)/);
    const volumeOnly = s.match(/(?:^|,\s*)(\d{1,4})(?:\s*,|\s*$)/);
    const pages = s.match(/\b(\d{1,5}\s*[-–]\s*\d{1,5})\b/);
    const articleNumber = s.match(/\b(?:article|art\.?|e)\s*([a-z0-9\-]{3,})\b/i);

    return {
        volume: volumeIssue?.[1] || volumeOnly?.[1] || '',
        number: volumeIssue?.[2]?.trim() || '',
        pages: pages?.[1]?.replace(/\s+/g, '') || '',
        eid: articleNumber?.[1] || ''
    };
};

const inferJournalFromApa = (reference) => {
    const preferred = cleanBibtexValue(reference?.journal || reference?.source || '');
    if (preferred) return preferred;

    const apa = stripApaFormatting(reference?.apa7 || '');
    const yearSplit = apa.split(/\(\d{4}[a-z]?\)\./i);
    if (yearSplit.length < 2) return '';

    const afterYear = yearSplit.slice(1).join(' ').trim();
    const firstPeriod = afterYear.indexOf('.');
    if (firstPeriod === -1) return '';
    const afterTitle = afterYear.slice(firstPeriod + 1).trim();
    if (!afterTitle) return '';

    const candidate = afterTitle.split(',')[0].trim();
    return cleanBibtexValue(candidate.replace(/https?:\/\/\S+$/i, '').trim());
};

const getBibtexHeuristics = (reference) => {
    const numeric = parseBibtexNumericMetadata(reference?.apa7 || '');
    return {
        journal: inferJournalFromApa(reference),
        volume: cleanBibtexValue(reference?.volume || numeric.volume),
        number: cleanBibtexValue(reference?.number || numeric.number),
        pages: cleanBibtexValue(reference?.pages || numeric.pages),
        eid: cleanBibtexValue(reference?.eid || reference?.articleNumber || numeric.eid)
    };
};

const enrichBibtexMetadataWithLlm = async (references, context, enabled) => {
    const heuristics = references.map(getBibtexHeuristics);
    if (!enabled || references.length === 0) return heuristics;

    const client = getOpenAiClient();
    if (!client) return heuristics;

    const limit = Number(process.env.BIBTEX_LLM_ENRICH_LIMIT || 60);
    const candidates = references
        .map((ref, idx) => ({
            idx,
            title: (ref?.title || '').toString(),
            apa7: (ref?.apa7 || '').toString(),
            source: (ref?.source || ref?.journal || '').toString(),
            needs: !(heuristics[idx].volume && (heuristics[idx].pages || heuristics[idx].eid))
        }))
        .filter(item => item.needs)
        .slice(0, limit)
        .map(({ idx, title, apa7, source }) => ({ idx, title, apa7, source }));

    if (candidates.length === 0) return heuristics;

    try {
        const completion = await client.chat.completions.create({
            model: process.env.BIBTEX_LLM_MODEL || 'gpt-4o-mini',
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
                {
                    role: 'system',
                    content: 'You extract bibliographic fields from citations. Return only valid JSON.'
                },
                {
                    role: 'user',
                    content: JSON.stringify({
                        task: 'For each item, infer journal, volume, number(issue), pages, and eid/article number if present. Use best-effort guesses.',
                        outputSchema: { items: [{ idx: 0, journal: '', volume: '', number: '', pages: '', eid: '' }] },
                        items: candidates
                    })
                }
            ]
        });

        const parsed = JSON.parse(completion?.choices?.[0]?.message?.content || '{}');
        const items = Array.isArray(parsed?.items) ? parsed.items : [];
        items.forEach(item => {
            const idx = Number(item?.idx);
            if (!Number.isInteger(idx) || idx < 0 || idx >= heuristics.length) return;

            const current = heuristics[idx];
            heuristics[idx] = {
                journal: current.journal || cleanBibtexValue(item.journal),
                volume: current.volume || cleanBibtexValue(item.volume),
                number: current.number || cleanBibtexValue(item.number),
                pages: current.pages || cleanBibtexValue(item.pages),
                eid: current.eid || cleanBibtexValue(item.eid)
            };
        });
    } catch (error) {
        context?.warn('BibTeX LLM enrichment failed, falling back to heuristics:', error.message);
    }

    return heuristics;
};

const formatBibtexEntry = (reference, metadata = {}) => {
    const authors = cleanBibtexValue((reference?.authors || reference?.author || '').toString().replace(/\s*&\s*/g, ' and '));
    const title = cleanBibtexValue(reference?.title || '');
    const year = cleanBibtexValue(reference?.year || '');
    const journal = cleanBibtexValue(metadata?.journal || reference?.journal || reference?.source || '');
    const publisher = cleanBibtexValue(reference?.publisher || '');
    const doi = cleanBibtexValue(reference?.doi || '');
    const url = cleanBibtexValue(reference?.url || reference?.link || '');
    const volume = cleanBibtexValue(metadata?.volume || reference?.volume || '');
    const number = cleanBibtexValue(metadata?.number || reference?.number || '');
    const pages = cleanBibtexValue(metadata?.pages || reference?.pages || '');
    const eid = cleanBibtexValue(metadata?.eid || reference?.eid || reference?.articleNumber || '');

    const entryType = journal ? 'article' : 'misc';
    const key = buildBibtexKey(reference);
    const fields = [];
    if (authors) fields.push(`  author = {${authors}}`);
    if (title) fields.push(`  title = {${title}}`);
    if (journal) fields.push(`  journal = {${journal}}`);
    if (publisher) fields.push(`  publisher = {${publisher}}`);
    if (year) fields.push(`  year = {${year}}`);
    if (volume) fields.push(`  volume = {${volume}}`);
    if (number) fields.push(`  number = {${number}}`);
    if (pages) fields.push(`  pages = {${pages}}`);
    if (eid) fields.push(`  eid = {${eid}}`);
    if (doi) fields.push(`  doi = {${doi}}`);
    if (url) fields.push(`  url = {${url}}`);

    return `@${entryType}{${key},\n${fields.join(',\n')}\n}`;
};

// GET /api/references/bibliography/export-docx - Export bibliography list as DOCX
app.http('ExportBibliographyDocx', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'references/bibliography/export-docx',
    handler: async (request, context) => {
        try {
            context.log('Exporting bibliography to DOCX');

            const references = await queryItems(CONTAINER_NAME, {
                query: BIBLIOGRAPHY_EXPORT_QUERY
            });

            const sorted = sortBibliographyReferences(references);
            const limited = sorted.slice(0, DOCX_EXPORT_MAX_ITEMS);
            const wasTruncated = sorted.length > limited.length;

            const paragraphs = limited.map(ref => {
                const text = sanitizeDocxText(buildExportCitationText(ref, { maxChars: 1000 }));

                return new Paragraph({
                    children: parseSimpleMarkdownRuns(text),
                    indent: { left: 720, hanging: 720 },
                    spacing: { after: 240 }
                });
            });

            if (wasTruncated) {
                paragraphs.push(new Paragraph({
                    children: [new TextRun({
                        text: `Export truncated to first ${limited.length} entries to avoid timeout.`,
                        font: 'Times New Roman',
                        size: 20,
                        italics: true
                    })],
                    spacing: { before: 240 }
                }));
            }

            const doc = new Document({
                sections: [
                    {
                        properties: {},
                        children: paragraphs.length > 0 ? paragraphs : [
                            new Paragraph({
                                children: [new TextRun({ text: 'No bibliography entries.', font: 'Times New Roman', size: 22 })]
                            })
                        ]
                    }
                ]
            });

            const buffer = await Packer.toBuffer(doc);
            const fileName = `bibliography_${new Date().toISOString().slice(0, 10)}.docx`;

            return {
                status: 200,
                isRaw: true,
                headers: {
                    'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                    'Content-Disposition': `attachment; filename="${fileName}"`
                },
                body: buffer
            };
        } catch (error) {
            context.error('Export Bibliography DOCX Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to export bibliography', details: error.message })
            };
        }
    }
});

// DELETE /api/references/{id} - Delete a reference
app.http('DeleteReference', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'references/{id}',
    handler: async (request, context) => {
        try {
            const id = request.params.id;
            const reference = await getItem(CONTAINER_NAME, id, id);
            if (!reference) {
                return {
                    status: 404,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Reference not found' })
                };
            }

            let jobRecord = buildDeleteJobRecord(id);
            jobRecord = await createItem(CONTAINER_JOBS, jobRecord);
            context.log(`Created delete job: ${jobRecord.id} for reference ${id}`);
            
            return {
                status: 202,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    success: true,
                    message: 'Reference deletion started',
                    referenceId: id,
                    jobId: jobRecord.id
                })
            };
        } catch (error) {
            context.error('Delete Reference Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    error: 'Failed to delete reference',
                    details: error.message,
                    cleanup: error?.details || null
                })
            };
        }
    }
});
