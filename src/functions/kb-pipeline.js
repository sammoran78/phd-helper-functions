const { app } = require('@azure/functions');
const { downloadBlob, uploadBlob } = require('../../shared/blobClient');
const { getItem, upsertItem, createItem } = require('../../shared/cosmosClient');
const mupdf = require('mupdf');

const CONTAINER_REFERENCES = process.env.COSMOSDB_CONTAINER_REFERENCES || 'references';
const CONTAINER_PAGES = process.env.COSMOSDB_CONTAINER_PAGES || 'pages';
const BLOB_CONTAINER_UPLOADS = process.env.BLOB_CONTAINER_UPLOADS || 'uploads';
const BLOB_CONTAINER_PAGES = process.env.BLOB_CONTAINER_PAGES || 'pages';

// POST /api/kb/split-pdf/{referenceId} - Split PDF into individual page images
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
            
            // 4. Open PDF with MuPDF and get page count
            context.log('[KB Split PDF] Opening PDF with MuPDF...');
            const doc = mupdf.Document.openDocument(pdfBuffer, 'application/pdf');
            const totalPages = doc.countPages();
            
            context.log(`[KB Split PDF] PDF has ${totalPages} pages`);
            
            // 5. Extract metadata from reference for page records
            const metadata = {
                title: reference.title || '',
                authors: reference.authors || '',
                year: reference.year || '',
                source: reference.source || '',
                type: reference.type || ''
            };
            
            const processedPages = [];
            
            // 6. Loop through each page
            for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
                context.log(`[KB Split PDF] Processing page ${pageNum}/${totalPages}`);
                
                try {
                    // Get the page (0-indexed in MuPDF)
                    const page = doc.loadPage(pageNum - 1);
                    
                    // Get page bounds and calculate scale for 300 DPI
                    // Default PDF is 72 DPI, so scale = 300/72 ≈ 4.17
                    const bounds = page.getBounds();
                    const scale = 300 / 72;
                    
                    // Create pixmap (render page to image)
                    const pixmap = page.toPixmap(
                        mupdf.Matrix.scale(scale, scale),
                        mupdf.ColorSpace.DeviceRGB,
                        false, // no alpha
                        true   // use annotations
                    );
                    
                    // Convert to JPEG with 90% quality
                    const jpegBuffer = pixmap.asJPEG(90);
                    
                    // Generate blob name for this page
                    const paddedPageNum = String(pageNum).padStart(4, '0');
                    const pageBlobName = `${referenceId}/page_${paddedPageNum}.jpg`;
                    
                    // Upload to blob storage
                    context.log(`[KB Split PDF] Uploading page ${pageNum} to blob: ${pageBlobName}`);
                    const blobUrl = await uploadBlob(
                        BLOB_CONTAINER_PAGES,
                        pageBlobName,
                        Buffer.from(jpegBuffer),
                        'image/jpeg'
                    );
                    
                    // Create CosmosDB record for this page
                    const pageRecord = {
                        id: `${referenceId}_page_${paddedPageNum}`,
                        referenceId: referenceId,
                        pageNumber: pageNum,
                        totalPages: totalPages,
                        blobUrl: blobUrl,
                        blobName: pageBlobName,
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
                    
                } catch (pageError) {
                    context.error(`[KB Split PDF] Error processing page ${pageNum}:`, pageError.message);
                    // Continue with other pages but log the error
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
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    success: true,
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
