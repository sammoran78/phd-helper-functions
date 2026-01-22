const { app } = require('@azure/functions');
const { uploadBlob } = require('../shared/blobClient');

app.http('UploadFile', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'references/upload',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const { name, data } = body;
            
            if (!name || !data) {
                return {
                    status: 400,
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ error: 'Missing file name or data' })
                };
            }
            
            const containerName = process.env.BLOB_CONTAINER_UPLOADS || 'uploads';
            
            // Generate unique filename
            const timestamp = Date.now();
            const sanitizedName = name.replace(/[^a-z0-9.]/gi, '_');
            const blobName = `${timestamp}_${sanitizedName}`;
            
            // Convert base64 to buffer
            const base64Data = data.replace(/^data:.*?;base64,/, '');
            const buffer = Buffer.from(base64Data, 'base64');
            
            // Determine content type
            let contentType = 'application/octet-stream';
            if (name.toLowerCase().endsWith('.pdf')) {
                contentType = 'application/pdf';
            } else if (name.toLowerCase().endsWith('.docx')) {
                contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
            }
            
            // Upload to Blob Storage
            const url = await uploadBlob(containerName, blobName, buffer, contentType);
            
            context.log(`Uploaded file: ${blobName} (${buffer.length} bytes)`);
            
            return {
                status: 200,
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ 
                    success: true, 
                    url: url, 
                    fileName: name,
                    blobName: blobName
                })
            };
        } catch (error) {
            context.error('Upload File Error:', error);
            return {
                status: 500,
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ error: 'Upload failed', details: error.message })
            };
        }
    }
});
