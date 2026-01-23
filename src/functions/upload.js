const { app } = require('@azure/functions');
const { uploadBlob } = require('../../shared/blobClient');

// POST /api/references/upload - Upload a file to Blob Storage
app.http('UploadFile', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'references/upload',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const { fileName, fileData, contentType } = body;
            
            if (!fileName || !fileData) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'fileName and fileData are required' })
                };
            }
            
            // Decode base64 file data
            const buffer = Buffer.from(fileData, 'base64');
            
            // Generate unique blob name
            const blobName = `${Date.now()}_${fileName}`;
            const containerName = process.env.BLOB_CONTAINER_UPLOADS || 'uploads';
            
            // Upload to blob storage
            const url = await uploadBlob(containerName, blobName, buffer, contentType || 'application/octet-stream');
            
            context.log(`Uploaded file: ${blobName}`);
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    success: true,
                    url: url,
                    fileName: fileName,
                    blobName: blobName
                })
            };
        } catch (error) {
            context.error('Upload Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to upload file', details: error.message })
            };
        }
    }
});
