const { app } = require('@azure/functions');
const { downloadBlob, uploadBlob } = require('../../shared/blobClient');
const { getItem, upsertItem, createItem, queryItems } = require('../../shared/cosmosClient');
const { PDFDocument } = require('pdf-lib');

const CONTAINER_REFERENCES = process.env.COSMOSDB_CONTAINER_REFERENCES || 'references';
const CONTAINER_PAGES = process.env.COSMOSDB_CONTAINER_PAGES || 'pages';
const CONTAINER_JOBS = process.env.COSMOSDB_CONTAINER_JOBS || 'jobs';
const BLOB_CONTAINER_UPLOADS = process.env.BLOB_CONTAINER_UPLOADS || 'uploads';
const BLOB_CONTAINER_PAGES = process.env.BLOB_CONTAINER_PAGES || 'pages';
const JOB_TTL_SECONDS = 300; // Auto-delete job records after 5 minutes

// POST /api/kb/split-pdf/{referenceId} - Split PDF into individual single-page PDFs
app.http('KBSplitPDF', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'kb/split-pdf/{referenceId}',
    handler: async (request, context) => {
        const referenceId = request.params.referenceId;
        let requestedJobId = null;

        try {
            const body = await request.json();
            if (body && typeof body.jobId === 'string') {
                requestedJobId = body.jobId.trim();
            }
        } catch (error) {
            requestedJobId = null;
        }
        
        context.log(`[KB Split PDF] Starting for reference: ${referenceId}`);
        
        try {
            // 1. Fetch the reference from CosmosDB
            const reference = await getItem(CONTAINER_REFERENCES, referenceId, referenceId);
            if (!reference) {
                return {
                    status: 404,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Reference not found' })
                };
            }
            
            // 2. Find PDF file in the reference's files array
            const files = reference.files || [];
            const pdfFile = files.find(f => 
                (f.name?.toLowerCase().endsWith('.pdf')) || 
                (f.url?.toLowerCase().endsWith('.pdf'))
            );
            
            if (!pdfFile) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'No PDF file found in this reference' })
                };
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
                return {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Failed to download PDF', details: downloadError.message })
                };
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
                    const paddedPageNum = String(pageNum).padStart(4, '0');
                    
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
                        pageNumber: pageNum,
                        totalPages: totalPages,
                        blobUrl: blobUrl,
                        blobName: pageBlobName,
                        fileType: 'pdf',
                        metadata: metadata,
                        ocrStatus: 0, // Not yet OCR'd
                        dateCreated: new Date().toISOString()
                    };
                    
                    await createItem(CONTAINER_PAGES, pageRecord);
                    
                    processedPages.push({
                        pageNumber: pageNum,
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
            
            return {
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
            };
            
        } catch (error) {
            context.error('[KB Split PDF] Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to split PDF', details: error.message })
            };
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
    const timeoutMs = 120000;

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
            return {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'endpointBaseUrl is required' })
            };
        }

        const ocrUrl = buildOcrUrl(endpointBaseUrl);
        if (!ocrUrl) {
            return {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Invalid endpointBaseUrl' })
            };
        }

        const validation = validateOcrUrl(ocrUrl);
        if (!validation.ok) {
            return {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: validation.error })
            };
        }

        try {
            const reference = await getItem(CONTAINER_REFERENCES, referenceId, referenceId);
            if (!reference) {
                return {
                    status: 404,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Reference not found' })
                };
            }

            const pages = await queryItems(CONTAINER_PAGES, {
                query: 'SELECT * FROM c WHERE c.referenceId = @referenceId ORDER BY c.pageNumber',
                parameters: [{ name: '@referenceId', value: referenceId }]
            });

            if (!pages || pages.length === 0) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'No split pages found for this reference. Run Step 1 first.' })
                };
            }

            const totalPages = pages.length;
            const jobId = requestedJobId || `job_${referenceId}_ocr_${Date.now()}`;
            const jobRecord = {
                id: jobId,
                referenceId: referenceId,
                type: 'ocr-pages',
                status: 'processing',
                totalPages: totalPages,
                pagesCompleted: 0,
                pagesFailed: 0,
                pagesSucceeded: 0,
                currentPage: 0,
                startedAt: new Date().toISOString(),
                ttl: JOB_TTL_SECONDS
            };

            await createItem(CONTAINER_JOBS, jobRecord);
            context.log(`[KB OCR] Created job record: ${jobId}`);
            context.log(`[KB OCR] OCR URL: ${ocrUrl}`);

            let pagesSucceeded = 0;
            let pagesFailed = 0;
            let pagesProcessed = 0;

            for (const page of pages) {
                const pageNumber = page.pageNumber;
                pagesProcessed += 1;
                context.log(`[KB OCR] Processing page ${pageNumber}/${totalPages} (${page.id})`);

                if (page.ocrStatus === 1 && typeof page.ocrText === 'string' && page.ocrText.trim()) {
                    pagesSucceeded += 1;
                    await upsertItem(CONTAINER_JOBS, {
                        ...jobRecord,
                        pagesCompleted: pagesProcessed,
                        pagesSucceeded,
                        pagesFailed,
                        currentPage: pageNumber,
                        lastUpdated: new Date().toISOString()
                    });
                    continue;
                }

                const processingRecord = {
                    ...page,
                    ocrStatus: 2,
                    ocrStartedAt: new Date().toISOString(),
                    ocrCompletedAt: null,
                    ocrError: null,
                    ocrText: null
                };
                await upsertItem(CONTAINER_PAGES, processingRecord);

                try {
                    const pdfBuffer = await downloadBlob(BLOB_CONTAINER_PAGES, page.blobName);
                    const ocrRes = await postPdfToOcr(ocrUrl, pdfBuffer, context);

                    if (!ocrRes.ok) {
                        pagesFailed += 1;
                        await upsertItem(CONTAINER_PAGES, {
                            ...processingRecord,
                            ocrStatus: -1,
                            ocrError: ocrRes.error || 'OCR request failed',
                            ocrText: null,
                            ocrCompletedAt: new Date().toISOString()
                        });
                    } else {
                        const ocrResult = extractOcrText(ocrRes.payload);
                        const extracted = ocrResult.text || (typeof ocrRes.rawText === 'string' ? ocrRes.rawText.trim() : null);

                        if (!extracted) {
                            pagesFailed += 1;
                            await upsertItem(CONTAINER_PAGES, {
                                ...processingRecord,
                                ocrStatus: -1,
                                ocrError: 'OCR response did not include extractable text',
                                ocrText: null,
                                ocrCompletedAt: new Date().toISOString()
                            });
                        } else {
                            pagesSucceeded += 1;
                            await upsertItem(CONTAINER_PAGES, {
                                ...processingRecord,
                                ocrStatus: 1,
                                ocrError: null,
                                ocrText: extracted,
                                printPublishedPage: ocrResult.printPage || null,
                                ocrCompletedAt: new Date().toISOString()
                            });
                        }
                    }

                } catch (pageError) {
                    pagesFailed += 1;
                    context.error(`[KB OCR] Error processing page ${pageNumber}:`, pageError.message);
                    await upsertItem(CONTAINER_PAGES, {
                        ...processingRecord,
                        ocrStatus: -1,
                        ocrError: pageError.message,
                        ocrCompletedAt: new Date().toISOString()
                    });
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

            await upsertItem(CONTAINER_JOBS, {
                ...jobRecord,
                status: 'complete',
                pagesCompleted: totalPages,
                pagesSucceeded,
                pagesFailed,
                completedAt: new Date().toISOString(),
                ttl: JOB_TTL_SECONDS
            });

            return {
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
            };

        } catch (error) {
            context.error('[KB OCR] Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to OCR pages', details: error.message })
            };
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
                    status: job.status,
                    totalPages: job.totalPages,
                    pagesCompleted: job.pagesCompleted,
                    pagesFailed: job.pagesFailed,
                    pagesSucceeded: job.pagesSucceeded,
                    currentPage: job.currentPage,
                    progress: job.totalPages > 0 ? Math.round((job.pagesCompleted / job.totalPages) * 100) : 0,
                    startedAt: job.startedAt,
                    completedAt: job.completedAt,
                    error: job.error
                })
            };
        } catch (error) {
            context.error('[KB Job Status] Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to get job status', details: error.message })
            };
        }
    }
});
