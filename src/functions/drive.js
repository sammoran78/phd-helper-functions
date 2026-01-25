const { app } = require('@azure/functions');
const { getDriveClient } = require('../../shared/googleAuth');

// GET /api/drive/files - List files in a folder
app.http('GetDriveFiles', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'drive/files',
    handler: async (request, context) => {
        try {
            const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
            if (!folderId) {
                return {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'GOOGLE_DRIVE_FOLDER_ID not configured' })
                };
            }

            const drive = await getDriveClient();
            
            context.log(`Listing files in folder: ${folderId}`);
            
            const response = await drive.files.list({
                q: `'${folderId}' in parents and trashed = false`,
                fields: 'files(id, name, mimeType, size, createdTime, modifiedTime, webViewLink, webContentLink)',
                orderBy: 'modifiedTime desc',
                pageSize: 100
            });
            
            const files = response.data.files.map(file => ({
                id: file.id,
                name: file.name,
                mimeType: file.mimeType,
                size: file.size,
                createdTime: file.createdTime,
                modifiedTime: file.modifiedTime,
                webViewLink: file.webViewLink,
                webContentLink: file.webContentLink
            }));
            
            context.log(`Found ${files.length} files`);
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(files)
            };
        } catch (error) {
            context.error('Get Drive Files Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to list drive files', details: error.message })
            };
        }
    }
});

// GET /api/drive/file/{id} - Fetch a Google Doc as HTML
app.http('GetDriveFile', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'drive/file/{id}',
    handler: async (request, context) => {
        try {
            const fileId = request.params.id;
            if (!fileId) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'File ID is required' })
                };
            }

            const drive = await getDriveClient();
            const meta = await drive.files.get({ fileId, fields: 'mimeType, name' });
            const mimeType = meta?.data?.mimeType;

            if (mimeType !== 'application/vnd.google-apps.document') {
                return {
                    status: 415,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        error: 'Unsupported file type',
                        details: `Only Google Docs are supported. Found: ${mimeType || 'unknown'}`
                    })
                };
            }

            const response = await drive.files.export(
                { fileId, mimeType: 'text/html' },
                { responseType: 'text' }
            );

            return {
                status: 200,
                headers: { 'Content-Type': 'text/html; charset=utf-8' },
                body: response.data
            };
        } catch (error) {
            context.error('Get Drive File Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to fetch drive file', details: error.message })
            };
        }
    }
});

// POST /api/drive/upload - Upload a file to Drive
app.http('UploadToDrive', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'drive/upload',
    handler: async (request, context) => {
        try {
            const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
            if (!folderId) {
                return {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'GOOGLE_DRIVE_FOLDER_ID not configured' })
                };
            }

            const body = await request.json();
            const { fileName, fileData, mimeType } = body;
            
            if (!fileName || !fileData) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'fileName and fileData are required' })
                };
            }

            const drive = await getDriveClient();
            
            // Decode base64 file data
            const buffer = Buffer.from(fileData, 'base64');
            
            context.log(`Uploading file: ${fileName} to folder ${folderId}`);
            
            const { Readable } = require('stream');
            const readable = new Readable();
            readable.push(buffer);
            readable.push(null);
            
            const response = await drive.files.create({
                requestBody: {
                    name: fileName,
                    parents: [folderId]
                },
                media: {
                    mimeType: mimeType || 'application/octet-stream',
                    body: readable
                },
                fields: 'id, name, webViewLink, webContentLink'
            });
            
            context.log(`Uploaded file: ${response.data.id}`);
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    success: true,
                    file: {
                        id: response.data.id,
                        name: response.data.name,
                        webViewLink: response.data.webViewLink,
                        webContentLink: response.data.webContentLink
                    }
                })
            };
        } catch (error) {
            context.error('Upload to Drive Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to upload file to drive', details: error.message })
            };
        }
    }
});

// DELETE /api/drive/files/{id} - Delete a file from Drive
app.http('DeleteDriveFile', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'drive/files/{id}',
    handler: async (request, context) => {
        try {
            const fileId = request.params.id;
            if (!fileId) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'File ID is required' })
                };
            }

            const drive = await getDriveClient();
            
            await drive.files.delete({ fileId: fileId });
            
            context.log(`Deleted file: ${fileId}`);
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true, message: 'File deleted' })
            };
        } catch (error) {
            context.error('Delete Drive File Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to delete file', details: error.message })
            };
        }
    }
});

// GET /api/drive/export/{id} - Export a Google Doc to PDF
app.http('ExportDriveFile', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'drive/export/{id}',
    handler: async (request, context) => {
        try {
            const fileId = request.params.id;
            const format = request.query.get('format') || 'pdf';
            
            if (!fileId) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'File ID is required' })
                };
            }

            const drive = await getDriveClient();
            
            const mimeTypes = {
                'pdf': 'application/pdf',
                'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'txt': 'text/plain'
            };
            
            const mimeType = mimeTypes[format] || 'application/pdf';
            
            context.log(`Exporting file ${fileId} as ${format}`);
            
            const response = await drive.files.export({
                fileId: fileId,
                mimeType: mimeType
            }, { responseType: 'arraybuffer' });
            
            return {
                status: 200,
                headers: {
                    'Content-Type': mimeType,
                    'Content-Disposition': `attachment; filename="export.${format}"`
                },
                body: Buffer.from(response.data)
            };
        } catch (error) {
            context.error('Export Drive File Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to export file', details: error.message })
            };
        }
    }
});
