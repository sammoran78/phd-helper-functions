const { app } = require('@azure/functions');
const { downloadBlob, uploadBlob } = require('../../shared/blobClient');
const { getItem, upsertItem, createItem, queryItems } = require('../../shared/cosmosClient');
const { PDFDocument } = require('pdf-lib');
const OpenAI = require('openai');

const CONTAINER_REFERENCES = process.env.COSMOSDB_CONTAINER_REFERENCES || 'references';
const CONTAINER_PAGES = process.env.COSMOSDB_CONTAINER_PAGES || 'pages';
const CONTAINER_JOBS = process.env.COSMOSDB_CONTAINER_JOBS || 'jobs';
const BLOB_CONTAINER_UPLOADS = process.env.BLOB_CONTAINER_UPLOADS || 'uploads';
const BLOB_CONTAINER_PAGES = process.env.BLOB_CONTAINER_PAGES || 'pages';
const JOB_TTL_SECONDS = 7200; // Auto-delete job records after 2 hours
const OCR_TIMEOUT_MS = Number(process.env.KB_OCR_TIMEOUT_MS || 120000);
const VECTORIZE_TIMEOUT_MS = Number(process.env.KB_VECTORIZE_TIMEOUT_MS || 180000);

// CORS headers helper
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
function withCorsHeaders(response) {
    return {
        ...response,
        headers: {
            ...response.headers,
            'Access-Control-Allow-Origin': CORS_ORIGIN,
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
    };
}

async function withTimeout(promise, timeoutMs, label) {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
    });

    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}

// POST /api/kb/split-pdf/{referenceId} - Split PDF into individual single-page PDFs
app.http('KBSplitPDF', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'kb/split-pdf/{referenceId}',
    handler: async (request, context) => {
        const referenceId = request.params.referenceId;
        let requestedJobId = null;
        let startPage = 1;

        const formatPrintedPageForBlob = (n) => {
            const num = Number(n);
            if (!Number.isFinite(num)) return '00000';
            const sign = num < 0 ? '-' : '';
            const abs = Math.abs(Math.trunc(num));
            return `${sign}${String(abs).padStart(5, '0')}`;
        };

        try {
            const body = await request.json();
            if (body && typeof body.jobId === 'string') {
                requestedJobId = body.jobId.trim();
            }

            if (body && (typeof body.startPage === 'number' || typeof body.startPage === 'string')) {
                const parsed = parseInt(body.startPage, 10);
                if (Number.isFinite(parsed)) {
                    startPage = parsed;
                }
            }
        } catch (error) {
            requestedJobId = null;
            startPage = 1;
        }
        
        context.log(`[KB Split PDF] Starting for reference: ${referenceId}`);
        
        try {
            // 1. Fetch the reference from CosmosDB
            const reference = await getItem(CONTAINER_REFERENCES, referenceId, referenceId);
            if (!reference) {
                return withCorsHeaders({
                    status: 404,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Reference not found' })
                });
            }
            
            // 2. Find PDF file in the reference's files array
            const files = reference.files || [];
            const pdfFile = files.find(f => 
                (f.name?.toLowerCase().endsWith('.pdf')) || 
                (f.url?.toLowerCase().endsWith('.pdf'))
            );
            
            if (!pdfFile) {
                return withCorsHeaders({
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'No PDF file found in this reference' })
                });
            }
            
            // Extract blob name from URL or use stored blobName
            let blobName = pdfFile.blobName;
            if (!blobName && pdfFile.url) {
                // Extract blob name from URL (format: https://account.blob.../container/blobname)
                const urlParts = pdfFile.url.split('/');
                blobName = urlParts.slice(-1)[0]; // Get last part as blob name
                // If it includes the container, get the path after container
                if (pdfFile.url.includes(BLOB_CONTAINER_UPLOADS)) {
                    const containerIndex = urlParts.indexOf(BLOB_CONTAINER_UPLOADS);
                    if (containerIndex !== -1) {
                        blobName = urlParts.slice(containerIndex + 1).join('/');
                    }
                }
            }
            
            context.log(`[KB Split PDF] Downloading PDF: ${blobName}`);
            
            // 3. Download the PDF from blob storage
            let pdfBuffer;
            try {
                pdfBuffer = await downloadBlob(BLOB_CONTAINER_UPLOADS, blobName);
                context.log(`[KB Split PDF] Downloaded ${pdfBuffer.length} bytes`);
            } catch (downloadError) {
                context.error('[KB Split PDF] Download failed:', downloadError.message);
                return withCorsHeaders({
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Failed to download PDF', details: downloadError.message })
                });
            }
            
            // 4. Load PDF with pdf-lib and get page count
            context.log('[KB Split PDF] Loading PDF with pdf-lib...');
            const pdfDoc = await PDFDocument.load(pdfBuffer);
            const totalPages = pdfDoc.getPageCount();
            
            context.log(`[KB Split PDF] PDF has ${totalPages} pages`);
            
            // 4.5 Create job status record for progress tracking
            const jobId = requestedJobId || `job_${referenceId}_${Date.now()}`;
            const jobRecord = {
                id: jobId,
                referenceId: referenceId,
                type: 'split-pdf',
                status: 'processing',
                totalPages: totalPages,
                pagesCompleted: 0,
                currentPage: 0,
                startedAt: new Date().toISOString(),
                ttl: JOB_TTL_SECONDS
            };
            await createItem(CONTAINER_JOBS, jobRecord);
            context.log(`[KB Split PDF] Created job record: ${jobId}`);
            
            // 5. Extract metadata from reference for page records
            const metadata = {
                title: reference.title || '',
                authors: reference.authors || '',
                year: reference.year || '',
                source: reference.source || '',
                type: reference.type || ''
            };
            
            const processedPages = [];
            
            // 6. Split each page into a separate PDF and upload
            for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
                context.log(`[KB Split PDF] Processing page ${pageNum}/${totalPages}`);
                
                try {
                    const printedPageNumber = startPage + pageNum - 1;
                    const paddedPageNum = formatPrintedPageForBlob(printedPageNumber);
                    
                    
                    // Create a new PDF with just this page
                    const singlePagePdf = await PDFDocument.create();
                    const [copiedPage] = await singlePagePdf.copyPages(pdfDoc, [pageNum - 1]);
                    singlePagePdf.addPage(copiedPage);
                    
                    // Save the single-page PDF to a buffer
                    const pdfBytes = await singlePagePdf.save();
                    
                    // Upload to blob storage
                    const pageBlobName = `${referenceId}/page_${paddedPageNum}.pdf`;
                    context.log(`[KB Split PDF] Uploading page ${pageNum} to blob: ${pageBlobName}`);
                    const blobUrl = await uploadBlob(
                        BLOB_CONTAINER_PAGES,
                        pageBlobName,
                        Buffer.from(pdfBytes),
                        'application/pdf'
                    );
                    
                    // Create CosmosDB record for this page
                    const pageRecord = {
                        id: `${referenceId}_page_${paddedPageNum}`,
                        referenceId: referenceId,
                        pageNumber: printedPageNumber,
                        pdfPageNumber: pageNum,
                        startPage: startPage,
                        totalPages: totalPages,
                        blobUrl: blobUrl,
                        blobName: pageBlobName,
                        fileType: 'pdf',
                        metadata: metadata,
                        ocrStatus: 0, // Not yet OCR'd
                        dateCreated: new Date().toISOString()
                    };
                    
                    await upsertItem(CONTAINER_PAGES, pageRecord);
                    
                    processedPages.push({
                        pageNumber: printedPageNumber,
                        pdfPageNumber: pageNum,
                        blobUrl: blobUrl,
                        recordId: pageRecord.id
                    });
                    
                    context.log(`[KB Split PDF] Page ${pageNum} completed`);
                    
                    // Update job progress
                    await upsertItem(CONTAINER_JOBS, {
                        ...jobRecord,
                        pagesCompleted: pageNum,
                        currentPage: pageNum,
                        lastUpdated: new Date().toISOString()
                    });
                    
                } catch (pageError) {
                    context.error(`[KB Split PDF] Error processing page ${pageNum}:`, pageError.message);
                    processedPages.push({
                        pageNumber: pageNum,
                        error: pageError.message
                    });
                }
            }
            
            // 7. Update ref_knowledge_status to 1 in the original reference
            context.log('[KB Split PDF] Updating reference knowledge status...');
            const updatedReference = {
                ...reference,
                ref_knowledge_status: 1,
                kb_split_completed: new Date().toISOString(),
                kb_total_pages: totalPages
            };
            
            await upsertItem(CONTAINER_REFERENCES, updatedReference);
            
            context.log(`[KB Split PDF] Completed! ${processedPages.length} pages processed`);
            
            // Mark job as complete
            await upsertItem(CONTAINER_JOBS, {
                ...jobRecord,
                status: 'complete',
                pagesCompleted: totalPages,
                completedAt: new Date().toISOString(),
                ttl: JOB_TTL_SECONDS
            });
            
            return withCorsHeaders({
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    success: true,
                    jobId: jobId,
                    referenceId: referenceId,
                    totalPages: totalPages,
                    processedPages: processedPages.length,
                    pages: processedPages,
                    newStatus: 1
                })
            });
            
        } catch (error) {
            context.error('[KB Split PDF] Error:', error);
            return withCorsHeaders({
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to split PDF', details: error.message })
            });
        }
    }
});

function normalizeEndpointBaseUrl(endpointBaseUrl = '') {
    const trimmed = endpointBaseUrl.trim();
    if (!trimmed) return '';
    return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

function buildOcrUrl(endpointBaseUrl = '') {
    const base = normalizeEndpointBaseUrl(endpointBaseUrl);
    if (!base) return '';
    if (base.endsWith('/v1/ocr')) return base;
    return `${base}/v1/ocr`;
}

function isPrivateIpV4(hostname = '') {
    const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!match) return false;
    const parts = match.slice(1).map(n => parseInt(n, 10));
    if (parts.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true;

    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
}

function validateOcrUrl(ocrUrl) {
    const allowLocal = (process.env.ALLOW_LOCAL_OCR || '').toLowerCase() === 'true';
    let parsed;

    try {
        parsed = new URL(ocrUrl);
    } catch (error) {
        return { ok: false, error: 'Invalid OCR URL' };
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { ok: false, error: 'OCR URL must be http(s)' };
    }

    const hostname = (parsed.hostname || '').toLowerCase();
    if (!hostname) {
        return { ok: false, error: 'OCR URL hostname is missing' };
    }

    if (!allowLocal) {
        if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
            return { ok: false, error: 'Localhost OCR URL is not allowed' };
        }

        if (isPrivateIpV4(hostname)) {
            return { ok: false, error: 'Private IP OCR URL is not allowed' };
        }
    }

    return { ok: true };
}

function extractOcrText(payload) {
    if (!payload) return { text: null, printPage: null };

    let text = null;
    let printPage = null;

    if (typeof payload === 'string') {
        text = payload.trim() || null;
    } else if (typeof payload.full_text === 'string') {
        text = payload.full_text.trim() || null;
        printPage = payload.print_published_page || null;
    } else if (typeof payload.text === 'string') {
        text = payload.text.trim() || null;
    } else if (typeof payload.ocr_text === 'string') {
        text = payload.ocr_text.trim() || null;
    } else if (typeof payload.result === 'string') {
        text = payload.result.trim() || null;
    } else if (payload.result && typeof payload.result.text === 'string') {
        text = payload.result.text.trim() || null;
    } else if (Array.isArray(payload.pages) && payload.pages.length > 0) {
        const pageTexts = payload.pages
            .map(p => (typeof p?.text === 'string' ? p.text.trim() : ''))
            .filter(Boolean);
        if (pageTexts.length > 0) text = pageTexts.join('\n\n');
    } else if (Array.isArray(payload.choices) && payload.choices.length > 0) {
        const content = payload.choices?.[0]?.message?.content;
        if (typeof content === 'string') text = content.trim() || null;
    }

    return { text, printPage };
}

async function postPdfToOcr(ocrUrl, pdfBuffer, context) {
    const errors = [];
    const timeoutMs = OCR_TIMEOUT_MS;

    try {
        const boundary = `----phdhelper${Date.now()}${Math.random().toString(16).slice(2)}`;
        const preamble = Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="file"; filename="page.pdf"\r\n` +
            `Content-Type: application/pdf\r\n\r\n`,
            'utf8'
        );
        const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
        const body = Buffer.concat([preamble, Buffer.from(pdfBuffer), epilogue]);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        const res = await fetch(ocrUrl, {
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`
            },
            body,
            signal: controller.signal
        });

        clearTimeout(timeout);

        if (res.ok) {
            const contentType = res.headers.get('content-type') || '';
            if (contentType.includes('application/json')) {
                const json = await res.json();
                return { ok: true, payload: json, rawText: null };
            }
            const text = await res.text();
            return { ok: true, payload: null, rawText: text };
        }

        const text = await res.text().catch(() => '');
        errors.push(`multipart failed: ${res.status} ${text}`);
    } catch (error) {
        errors.push(`multipart exception: ${error.message}`);
    }

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        const res = await fetch(ocrUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/pdf' },
            body: pdfBuffer,
            signal: controller.signal
        });

        clearTimeout(timeout);

        if (res.ok) {
            const contentType = res.headers.get('content-type') || '';
            if (contentType.includes('application/json')) {
                const json = await res.json();
                return { ok: true, payload: json, rawText: null };
            }
            const text = await res.text();
            return { ok: true, payload: null, rawText: text };
        }

        const text = await res.text().catch(() => '');
        errors.push(`raw failed: ${res.status} ${text}`);
    } catch (error) {
        errors.push(`raw exception: ${error.message}`);
    }

    context?.error?.('[KB OCR] All OCR request attempts failed:', errors.join(' | '));
    return { ok: false, payload: null, rawText: null, error: errors.join(' | ') };
}

app.http('KBOCRPages', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'kb/ocr-pages/{referenceId}',
    handler: async (request, context) => {
        const referenceId = request.params.referenceId;
        context.log(`[KB OCR] Starting for reference: ${referenceId}`);

        let endpointBaseUrl = '';
        let requestedJobId = null;
        let jobRecord = null;
        let pagesSucceeded = 0;
        let pagesFailed = 0;
        let totalPages = 0;

        try {
            const body = await request.json();
            endpointBaseUrl = typeof body?.endpointBaseUrl === 'string' ? body.endpointBaseUrl : '';
            if (typeof body?.jobId === 'string') {
                requestedJobId = body.jobId.trim();
            }
        } catch (error) {
            endpointBaseUrl = '';
            requestedJobId = null;
        }

        if (!endpointBaseUrl || !endpointBaseUrl.trim()) {
            return withCorsHeaders({
                status: 400,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'endpointBaseUrl is required' })
            });
        }

        const ocrUrl = buildOcrUrl(endpointBaseUrl);
        if (!ocrUrl) {
            return withCorsHeaders({
                status: 400,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Invalid endpointBaseUrl' })
            });
        }

        const validation = validateOcrUrl(ocrUrl);
        if (!validation.ok) {
            return withCorsHeaders({
                status: 400,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: validation.error })
            });
        }

        // Create job record IMMEDIATELY so frontend can poll
        const jobId = requestedJobId || `job_${referenceId}_ocr_${Date.now()}`;
        jobRecord = {
            id: jobId,
            referenceId: referenceId,
            type: 'ocr-pages',
            status: 'initializing',
            totalPages: 0,
            pagesCompleted: 0,
            pagesFailed: 0,
            pagesSucceeded: 0,
            retryTotal: 0,
            retryCompleted: 0,
            currentPage: 0,
            startedAt: new Date().toISOString(),
            ttl: JOB_TTL_SECONDS
        };

        try {
            await createItem(CONTAINER_JOBS, jobRecord);
            context.log(`[KB OCR] Created job record: ${jobId}`);
        } catch (createError) {
            context.error('[KB OCR] Failed to create job record:', createError);
            // Continue anyway - polling might fail but processing will still happen
        }

        try {
            const reference = await getItem(CONTAINER_REFERENCES, referenceId, referenceId);
            if (!reference) {
                await upsertItem(CONTAINER_JOBS, {
                    ...jobRecord,
                    status: 'error',
                    error: 'Reference not found',
                    completedAt: new Date().toISOString()
                });
                return withCorsHeaders({
                    status: 404,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Reference not found', jobId })
                });
            }

            const pages = await queryItems(CONTAINER_PAGES, {
                query: 'SELECT * FROM c WHERE c.referenceId = @referenceId ORDER BY c.pageNumber',
                parameters: [{ name: '@referenceId', value: referenceId }]
            });

            if (!pages || pages.length === 0) {
                await upsertItem(CONTAINER_JOBS, {
                    ...jobRecord,
                    status: 'error',
                    error: 'No split pages found for this reference. Run Step 1 first.',
                    completedAt: new Date().toISOString()
                });
                return withCorsHeaders({
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'No split pages found for this reference. Run Step 1 first.', jobId })
                });
            }

            totalPages = pages.length;
            
            // Update jobRecord with actual totalPages so subsequent updates include correct count
            jobRecord.totalPages = totalPages;
            
            // Update job record with actual page count and set to processing
            await upsertItem(CONTAINER_JOBS, {
                ...jobRecord,
                status: 'processing',
                totalPages: totalPages
            });
            context.log(`[KB OCR] OCR URL: ${ocrUrl}`);
            context.log(`[KB OCR] Pages to process: ${totalPages}`);

            let pagesProcessed = 0;
            const retryPages = [];

            const isSuccessfulOcrPage = (pageDoc) => (
                pageDoc?.ocrStatus === 1
                && typeof pageDoc?.ocrText === 'string'
                && pageDoc.ocrText.trim().length > 0
            );

            const getLatestPageRecord = async (pageId) => {
                try {
                    return await getItem(CONTAINER_PAGES, pageId, pageId);
                } catch (readError) {
                    context.warn?.(`[KB OCR] Could not refresh page ${pageId}: ${readError.message}`);
                    return null;
                }
            };

            const runOcrForPage = async (page, attempt) => {
                const pageNumber = page.pageNumber;
                const latestBeforeStart = await getLatestPageRecord(page.id);
                const baselinePage = latestBeforeStart || page;

                if (isSuccessfulOcrPage(baselinePage)) {
                    return { ok: true };
                }

                const processingRecord = {
                    ...baselinePage,
                    ocrStatus: 2,
                    ocrStartedAt: new Date().toISOString(),
                    ocrCompletedAt: null,
                    ocrError: null,
                    ocrText: null,
                    ocrAttempt: attempt
                };
                await upsertItem(CONTAINER_PAGES, processingRecord);

                try {
                    const runAttempt = async () => {
                        const pdfBuffer = await downloadBlob(BLOB_CONTAINER_PAGES, baselinePage.blobName || page.blobName);
                        return await postPdfToOcr(ocrUrl, pdfBuffer, context);
                    };

                    const ocrRes = await withTimeout(
                        runAttempt(),
                        OCR_TIMEOUT_MS,
                        `OCR page ${pageNumber}`
                    );

                    if (!ocrRes.ok) {
                        const latestAfterFailure = await getLatestPageRecord(page.id);
                        if (isSuccessfulOcrPage(latestAfterFailure)) {
                            return { ok: true };
                        }

                        await upsertItem(CONTAINER_PAGES, {
                            ...(latestAfterFailure || processingRecord),
                            ocrStatus: -1,
                            ocrError: ocrRes.error || 'OCR request failed',
                            ocrText: null,
                            ocrCompletedAt: new Date().toISOString()
                        });
                        return { ok: false };
                    }

                    const ocrResult = extractOcrText(ocrRes.payload);
                    const extracted = ocrResult.text || (typeof ocrRes.rawText === 'string' ? ocrRes.rawText.trim() : null);

                    if (!extracted) {
                        const latestAfterFailure = await getLatestPageRecord(page.id);
                        if (isSuccessfulOcrPage(latestAfterFailure)) {
                            return { ok: true };
                        }

                        await upsertItem(CONTAINER_PAGES, {
                            ...(latestAfterFailure || processingRecord),
                            ocrStatus: -1,
                            ocrError: 'OCR response did not include extractable text',
                            ocrText: null,
                            ocrCompletedAt: new Date().toISOString()
                        });
                        return { ok: false };
                    }

                    const latestBeforeSuccessWrite = await getLatestPageRecord(page.id);
                    const successRecordBase = latestBeforeSuccessWrite || processingRecord;
                    if (isSuccessfulOcrPage(successRecordBase)) {
                        return { ok: true };
                    }

                    await upsertItem(CONTAINER_PAGES, {
                        ...successRecordBase,
                        ocrStatus: 1,
                        ocrError: null,
                        ocrText: extracted,
                        printPublishedPage: ocrResult.printPage || null,
                        ocrCompletedAt: new Date().toISOString()
                    });
                    return { ok: true };
                } catch (pageError) {
                    context.error(`[KB OCR] Error processing page ${pageNumber}:`, pageError.message);

                    const latestAfterFailure = await getLatestPageRecord(page.id);
                    if (isSuccessfulOcrPage(latestAfterFailure)) {
                        return { ok: true };
                    }

                    await upsertItem(CONTAINER_PAGES, {
                        ...(latestAfterFailure || processingRecord),
                        ocrStatus: -1,
                        ocrError: pageError.message,
                        ocrCompletedAt: new Date().toISOString()
                    });
                    return { ok: false };
                }
            };

            for (const page of pages) {
                const pageNumber = page.pageNumber;
                pagesProcessed += 1;
                context.log(`[KB OCR] Processing page ${pageNumber}/${totalPages} (${page.id})`);

                if (page.ocrStatus === 1 && typeof page.ocrText === 'string' && page.ocrText.trim()) {
                    pagesSucceeded += 1;
                } else {
                    const ocrResult = await runOcrForPage(page, 1);
                    if (ocrResult.ok) {
                        pagesSucceeded += 1;
                    } else {
                        pagesFailed += 1;
                        retryPages.push(page);
                    }
                }

                await upsertItem(CONTAINER_JOBS, {
                    ...jobRecord,
                    pagesCompleted: pagesProcessed,
                    pagesSucceeded,
                    pagesFailed,
                    currentPage: pageNumber,
                    lastUpdated: new Date().toISOString()
                });
            }

            if (retryPages.length > 0) {
                let retryCompleted = 0;
                await upsertItem(CONTAINER_JOBS, {
                    ...jobRecord,
                    status: 'retrying',
                    pagesCompleted: totalPages,
                    pagesSucceeded,
                    pagesFailed,
                    retryTotal: retryPages.length,
                    retryCompleted: 0,
                    lastUpdated: new Date().toISOString()
                });

                for (const page of retryPages) {
                    retryCompleted += 1;
                    const retryResult = await runOcrForPage(page, 2);
                    if (retryResult.ok) {
                        pagesSucceeded += 1;
                        pagesFailed = Math.max(0, pagesFailed - 1);
                    }

                    await upsertItem(CONTAINER_JOBS, {
                        ...jobRecord,
                        status: 'retrying',
                        pagesCompleted: totalPages,
                        pagesSucceeded,
                        pagesFailed,
                        retryTotal: retryPages.length,
                        retryCompleted,
                        currentPage: page.pageNumber,
                        lastUpdated: new Date().toISOString()
                    });
                }
            }

            const allSucceeded = pagesFailed === 0 && pagesSucceeded === totalPages;
            const newStatus = allSucceeded ? 2 : (reference.ref_knowledge_status || 1);
            const updatedReference = {
                ...reference,
                ref_knowledge_status: newStatus,
                kb_ocr_completed: new Date().toISOString(),
                kb_ocr_pages_succeeded: pagesSucceeded,
                kb_ocr_pages_failed: pagesFailed
            };
            await upsertItem(CONTAINER_REFERENCES, updatedReference);

            const finalStatus = pagesFailed > 0 ? 'complete_with_errors' : 'complete';
            const jobError = pagesFailed > 0 ? `${pagesFailed} page(s) failed` : null;
            await upsertItem(CONTAINER_JOBS, {
                ...jobRecord,
                status: finalStatus,
                pagesCompleted: totalPages,
                pagesSucceeded,
                pagesFailed,
                retryTotal: retryPages.length,
                retryCompleted: retryPages.length,
                completedAt: new Date().toISOString(),
                error: jobError,
                ttl: JOB_TTL_SECONDS
            });

            return withCorsHeaders({
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    success: true,
                    jobId,
                    referenceId,
                    ocrUrl,
                    totalPages,
                    pagesProcessed: totalPages,
                    pagesSucceeded,
                    pagesFailed,
                    newStatus
                })
            });

        } catch (error) {
            context.error('[KB OCR] Error:', error);
            if (jobRecord) {
                await upsertItem(CONTAINER_JOBS, {
                    ...jobRecord,
                    status: 'error',
                    pagesCompleted: pagesSucceeded + pagesFailed,
                    pagesSucceeded,
                    pagesFailed,
                    completedAt: new Date().toISOString(),
                    error: error.message,
                    ttl: JOB_TTL_SECONDS
                });
            }
            return withCorsHeaders({
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to OCR pages', details: error.message })
            });
        }
    }
});

// GET /api/kb/job-status/{jobId} - Get job progress status
app.http('KBJobStatus', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'kb/job-status/{jobId}',
    handler: async (request, context) => {
        const jobId = request.params.jobId;
        
        try {
            const job = await getItem(CONTAINER_JOBS, jobId, jobId);
            
            if (!job) {
                return withCorsHeaders({
                    status: 404,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Job not found' })
                });
            }
            
            return withCorsHeaders({
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jobId: job.id,
                    referenceId: job.referenceId,
                    status: job.status,
                    totalPages: job.totalPages,
                    pagesCompleted: job.pagesCompleted,
                    pagesFailed: job.pagesFailed,
                    pagesSucceeded: job.pagesSucceeded,
                    currentPage: job.currentPage,
                    progress: job.totalPages > 0 ? Math.round((job.pagesCompleted / job.totalPages) * 100) : 0,
                    retryTotal: job.retryTotal || 0,
                    retryCompleted: job.retryCompleted || 0,
                    startedAt: job.startedAt,
                    completedAt: job.completedAt,
                    error: job.error
                })
            });
        } catch (error) {
            context.error('[KB Job Status] Error:', error);
            return withCorsHeaders({
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to get job status', details: error.message })
            });
        }
    }
});

// Helper: Truncate string to max length for OpenAI attributes (512 char limit)
function truncateForAttribute(str, maxLen = 500) {
    if (!str || typeof str !== 'string') return '';
    if (str.length <= maxLen) return str;
    return str.substring(0, maxLen - 3) + '...';
}

// Helper: Build file content with metadata header for vector store
function buildVectorFileContent(page) {
    const meta = page.metadata || {};
    const header = [
        '[DOC_METADATA]',
        `referenceId: ${page.referenceId || ''}`,
        `pageNumber: ${page.pageNumber || ''}`,
        `title: ${meta.title || ''}`,
        `authors: ${meta.authors || ''}`,
        `year: ${meta.year || ''}`,
        `type: ${meta.type || ''}`,
        `source: ${meta.source || ''}`,
        '[/DOC_METADATA]',
        '',
        ''
    ].join('\n');
    
    return header + (page.ocrText || '');
}

// Helper: Build attributes object for OpenAI vector store
function buildVectorAttributes(page) {
    const meta = page.metadata || {};
    return {
        referenceId: page.referenceId || '',
        pageNumber: String(page.pageNumber || ''),
        title: truncateForAttribute(meta.title),
        authors: truncateForAttribute(meta.authors),
        year: String(meta.year || ''),
        type: meta.type || '',
        source: truncateForAttribute(meta.source),
        blobUrl: truncateForAttribute(page.blobUrl)
    };
}

// POST /api/kb/vectorize/{referenceId} - Upload OCR'd pages to OpenAI vector store
app.http('KBVectorizePages', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'kb/vectorize/{referenceId}',
    handler: async (request, context) => {
        const referenceId = request.params.referenceId;
        context.log(`[KB Vectorize] Starting for reference: ${referenceId}`);

        const VECTOR_STORE_ID = process.env.OPENAI_VECTOR_STORE;
        const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

        if (!VECTOR_STORE_ID) {
            return withCorsHeaders({
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'OPENAI_VECTOR_STORE environment variable not configured' })
            });
        }

        if (!OPENAI_API_KEY) {
            return withCorsHeaders({
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'OPENAI_API_KEY environment variable not configured' })
            });
        }

        let requestedJobId = null;
        try {
            const body = await request.json();
            if (body && typeof body.jobId === 'string') {
                requestedJobId = body.jobId.trim();
            }
        } catch (error) {
            requestedJobId = null;
        }

        let jobRecord = null;
        let pagesSucceeded = 0;
        let pagesFailed = 0;
        let totalPages = 0;

        try {
            // Initialize OpenAI client
            const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

            // Create job record IMMEDIATELY so frontend can poll
            const jobId = requestedJobId || `job_${referenceId}_vectorize_${Date.now()}`;
            jobRecord = {
                id: jobId,
                referenceId: referenceId,
                type: 'vectorize-pages',
                status: 'initializing',
                totalPages: 0,
                pagesCompleted: 0,
                pagesFailed: 0,
                pagesSucceeded: 0,
                retryTotal: 0,
                retryCompleted: 0,
                currentPage: 0,
                vectorStoreId: VECTOR_STORE_ID,
                startedAt: new Date().toISOString(),
                ttl: JOB_TTL_SECONDS
            };
            await createItem(CONTAINER_JOBS, jobRecord);
            context.log(`[KB Vectorize] Created job record: ${jobId}`);

            // Fetch the reference
            const reference = await getItem(CONTAINER_REFERENCES, referenceId, referenceId);
            if (!reference) {
                await upsertItem(CONTAINER_JOBS, {
                    ...jobRecord,
                    status: 'error',
                    error: 'Reference not found',
                    completedAt: new Date().toISOString()
                });
                return withCorsHeaders({
                    status: 404,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Reference not found', jobId })
                });
            }

            // Query pages with ocrStatus=1 and no openaiVector yet
            const pages = await queryItems(CONTAINER_PAGES, {
                query: `SELECT * FROM c 
                        WHERE c.referenceId = @referenceId 
                          AND c.ocrStatus = 1 
                          AND (
                              NOT IS_DEFINED(c.openaiVector)
                              OR c.openaiVector = null
                              OR c.openaiVector.fileId = null
                              OR (IS_DEFINED(c.openaiVector.status) AND c.openaiVector.status != 'completed')
                          )
                        ORDER BY c.pageNumber`,
                parameters: [{ name: '@referenceId', value: referenceId }]
            });

            if (!pages || pages.length === 0) {
                // Check if all pages are already vectorized
                const allPages = await queryItems(CONTAINER_PAGES, {
                    query: 'SELECT * FROM c WHERE c.referenceId = @referenceId',
                    parameters: [{ name: '@referenceId', value: referenceId }]
                });

                if (!allPages || allPages.length === 0) {
                    await upsertItem(CONTAINER_JOBS, {
                        ...jobRecord,
                        status: 'error',
                        error: 'No pages found for this reference. Run Step 1 (split) and Step 2 (OCR) first.',
                        completedAt: new Date().toISOString()
                    });
                    return withCorsHeaders({
                        status: 400,
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ error: 'No pages found for this reference. Run Step 1 (split) and Step 2 (OCR) first.', jobId })
                    });
                }

                const alreadyVectorized = allPages.filter(p => p.openaiVector && p.openaiVector.fileId);
                if (alreadyVectorized.length === allPages.length) {
                    await upsertItem(CONTAINER_JOBS, {
                        ...jobRecord,
                        status: 'complete',
                        totalPages: allPages.length,
                        pagesCompleted: allPages.length,
                        pagesSucceeded: allPages.length,
                        pagesFailed: 0,
                        completedAt: new Date().toISOString()
                    });
                    return withCorsHeaders({
                        status: 200,
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            success: true,
                            message: 'All pages already vectorized',
                            referenceId,
                            totalPages: allPages.length,
                            pagesVectorized: alreadyVectorized.length,
                            jobId
                        })
                    });
                }

                const pendingOcr = allPages.filter(p => p.ocrStatus !== 1);
                if (pendingOcr.length > 0) {
                    await upsertItem(CONTAINER_JOBS, {
                        ...jobRecord,
                        status: 'error',
                        error: 'Some pages have not completed OCR yet. Run Step 2 first.',
                        completedAt: new Date().toISOString()
                    });
                    return withCorsHeaders({
                        status: 400,
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ 
                            error: 'Some pages have not completed OCR yet. Run Step 2 first.',
                            pendingOcrCount: pendingOcr.length,
                            jobId
                        })
                    });
                }
            }

            totalPages = pages.length;
            
            // Update jobRecord with actual totalPages so subsequent updates include correct count
            jobRecord.totalPages = totalPages;
            
            // Update job record with actual page count and set to processing
            await upsertItem(CONTAINER_JOBS, {
                ...jobRecord,
                status: 'processing',
                totalPages: totalPages
            });
            context.log(`[KB Vectorize] Vector Store ID: ${VECTOR_STORE_ID}`);
            context.log(`[KB Vectorize] Pages to process: ${totalPages}`);

            let pagesProcessed = 0;
            const retryPages = [];

            const runVectorizeForPage = async (page, attempt) => {
                const pageNumber = page.pageNumber;
                if (page.openaiVector?.status === 'completed') {
                    return { ok: true };
                }

                const fileName = `${referenceId}_page_${String(pageNumber).padStart(5, '0')}.txt`;

                const uploadAndIndex = async () => {
                    const fileContent = buildVectorFileContent(page);
                    const attributes = buildVectorAttributes(page);
                    const file = await openai.files.create({
                        file: new File([fileContent], fileName, { type: 'text/plain' }),
                        purpose: 'assistants'
                    });

                    const vectorStoreFile = await openai.vectorStores.files.createAndPoll(
                        VECTOR_STORE_ID,
                        {
                            file_id: file.id,
                            attributes: attributes,
                            chunking_strategy: {
                                type: 'static',
                                static: {
                                    max_chunk_size_tokens: 800,
                                    chunk_overlap_tokens: 200
                                }
                            }
                        }
                    );

                    return { file, vectorStoreFile };
                };

                try {
                    const { file, vectorStoreFile } = await withTimeout(
                        uploadAndIndex(),
                        VECTORIZE_TIMEOUT_MS,
                        `Vectorize page ${pageNumber}`
                    );

                    if (vectorStoreFile.status === 'completed') {
                        await upsertItem(CONTAINER_PAGES, {
                            ...page,
                            openaiVector: {
                                vectorStoreId: VECTOR_STORE_ID,
                                fileId: file.id,
                                vectorStoreFileId: vectorStoreFile.id,
                                status: 'completed',
                                attempt,
                                uploadedAt: new Date().toISOString()
                            }
                        });
                        return { ok: true };
                    }

                    await upsertItem(CONTAINER_PAGES, {
                        ...page,
                        openaiVector: {
                            vectorStoreId: VECTOR_STORE_ID,
                            fileId: file.id,
                            vectorStoreFileId: vectorStoreFile.id,
                            status: vectorStoreFile.status || 'failed',
                            attempt,
                            error: vectorStoreFile.last_error?.message || 'Failed to index',
                            uploadedAt: new Date().toISOString()
                        }
                    });
                    return { ok: false };
                } catch (pageError) {
                    context.error(`[KB Vectorize] Error processing page ${pageNumber}:`, pageError.message);

                    await upsertItem(CONTAINER_PAGES, {
                        ...page,
                        openaiVector: {
                            vectorStoreId: VECTOR_STORE_ID,
                            status: 'failed',
                            attempt,
                            error: pageError.message,
                            failedAt: new Date().toISOString()
                        }
                    });
                    return { ok: false };
                }
            };

            for (const page of pages) {
                const pageNumber = page.pageNumber;
                pagesProcessed += 1;
                context.log(`[KB Vectorize] Processing page ${pageNumber} (${pagesProcessed}/${totalPages})`);

                const vectorizeResult = await runVectorizeForPage(page, 1);
                if (vectorizeResult.ok) {
                    pagesSucceeded += 1;
                } else {
                    pagesFailed += 1;
                    retryPages.push(page);
                }

                // Update job progress
                await upsertItem(CONTAINER_JOBS, {
                    ...jobRecord,
                    pagesCompleted: pagesProcessed,
                    pagesSucceeded,
                    pagesFailed,
                    currentPage: pageNumber,
                    lastUpdated: new Date().toISOString()
                });
            }

            if (retryPages.length > 0) {
                let retryCompleted = 0;
                await upsertItem(CONTAINER_JOBS, {
                    ...jobRecord,
                    status: 'retrying',
                    pagesCompleted: totalPages,
                    pagesSucceeded,
                    pagesFailed,
                    retryTotal: retryPages.length,
                    retryCompleted: 0,
                    lastUpdated: new Date().toISOString()
                });

                for (const page of retryPages) {
                    retryCompleted += 1;
                    const retryResult = await runVectorizeForPage(page, 2);
                    if (retryResult.ok) {
                        pagesSucceeded += 1;
                        pagesFailed = Math.max(0, pagesFailed - 1);
                    }

                    await upsertItem(CONTAINER_JOBS, {
                        ...jobRecord,
                        status: 'retrying',
                        pagesCompleted: totalPages,
                        pagesSucceeded,
                        pagesFailed,
                        retryTotal: retryPages.length,
                        retryCompleted,
                        currentPage: page.pageNumber,
                        lastUpdated: new Date().toISOString()
                    });
                }
            }

            // Update reference status
            const allSucceeded = pagesFailed === 0 && pagesSucceeded === totalPages;
            const newStatus = allSucceeded ? 3 : (reference.ref_knowledge_status || 2);
            const updatedReference = {
                ...reference,
                ref_knowledge_status: newStatus,
                kb_vectorize_completed: new Date().toISOString(),
                kb_vectorize_pages_succeeded: pagesSucceeded,
                kb_vectorize_pages_failed: pagesFailed,
                kb_vector_store_id: VECTOR_STORE_ID
            };
            await upsertItem(CONTAINER_REFERENCES, updatedReference);

            // Mark job complete (with error status if any pages failed)
            const finalStatus = pagesFailed > 0 ? 'complete_with_errors' : 'complete';
            const jobError = pagesFailed > 0 ? `${pagesFailed} page(s) failed` : null;
            await upsertItem(CONTAINER_JOBS, {
                ...jobRecord,
                status: finalStatus,
                pagesCompleted: totalPages,
                pagesSucceeded,
                pagesFailed,
                retryTotal: retryPages.length,
                retryCompleted: retryPages.length,
                completedAt: new Date().toISOString(),
                error: jobError,
                ttl: JOB_TTL_SECONDS
            });

            context.log(`[KB Vectorize] Completed! ${pagesSucceeded}/${totalPages} pages vectorized`);

            return withCorsHeaders({
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    success: true,
                    jobId,
                    referenceId,
                    vectorStoreId: VECTOR_STORE_ID,
                    totalPages,
                    pagesSucceeded,
                    pagesFailed,
                    newStatus
                })
            });

        } catch (error) {
            context.error('[KB Vectorize] Error:', error);
            if (jobRecord) {
                await upsertItem(CONTAINER_JOBS, {
                    ...jobRecord,
                    status: 'error',
                    pagesCompleted: pagesSucceeded + pagesFailed,
                    pagesSucceeded,
                    pagesFailed,
                    completedAt: new Date().toISOString(),
                    error: error.message,
                    ttl: JOB_TTL_SECONDS
                });
            }
            return withCorsHeaders({
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to vectorize pages', details: error.message })
            });
        }
    }
});
