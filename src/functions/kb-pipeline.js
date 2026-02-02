const { app } = require('@azure/functions');
const { downloadBlob, uploadBlob } = require('../../shared/blobClient');
const { getItem, upsertItem, createItem } = require('../../shared/cosmosClient');
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
            const jobId = `job_${referenceId}_${Date.now()}`;
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
                    currentPage: job.currentPage,
                    progress: job.totalPages > 0 ? Math.round((job.pagesCompleted / job.totalPages) * 100) : 0,
                    startedAt: job.startedAt,
                    completedAt: job.completedAt
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
