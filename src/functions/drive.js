const { app } = require('@azure/functions');
const { Readable } = require('stream');
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
const { getDriveClient, getDocsClient } = require('../../shared/googleAuth');
const { upsertItem } = require('../../shared/cosmosClient');
const mammoth = require('mammoth');

const ANALYTICS_CONTAINER = process.env.COSMOSDB_CONTAINER_ANALYTICS || 'analytics';
const WRITING_ANALYTICS_LATEST_ID = 'writing_analytics_latest';
const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function countWords(text) {
    const s = (text || '').replace(/\s+/g, ' ').trim();
    if (!s) return 0;
    const matches = s.match(/\S+/g);
    return matches ? matches.length : 0;
}

function decodeHtmlEntities(input) {
    return (input || '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function htmlToPlainText(html) {
    const withBreaks = (html || '')
        .replace(/<\s*br\s*\/?\s*>/gi, '\n')
        .replace(/<\s*\/\s*(p|div|h1|h2|h3|h4|h5|h6|li)\s*>/gi, '\n')
        .replace(/<\s*li[^>]*>/gi, '- ')
        .replace(/<\s*\/\s*(ul|ol)\s*>/gi, '\n');

    const withoutTags = withBreaks.replace(/<[^>]+>/g, '');
    const decoded = decodeHtmlEntities(withoutTags)
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    return decoded;
}

function parseInlineRuns(htmlFragment) {
    const runs = [];
    const styleStack = [{ bold: false, italics: false, underline: false }];
    const tokenRegex = /<(\/)?(b|strong|i|em|u|br)[^>]*>|([^<]+)/gi;
    let match;

    while ((match = tokenRegex.exec(htmlFragment || '')) !== null) {
        const isClosing = Boolean(match[1]);
        const tag = (match[2] || '').toLowerCase();
        const textNode = match[3];

        if (textNode) {
            const text = decodeHtmlEntities(textNode);
            if (text.length > 0) {
                const style = styleStack[styleStack.length - 1] || {};
                runs.push(new TextRun({
                    text,
                    bold: Boolean(style.bold),
                    italics: Boolean(style.italics),
                    underline: style.underline ? {} : undefined
                }));
            }
            continue;
        }

        if (tag === 'br') {
            runs.push(new TextRun({ text: '\n' }));
            continue;
        }

        if (isClosing) {
            if (styleStack.length > 1) styleStack.pop();
            continue;
        }

        const previous = styleStack[styleStack.length - 1] || {};
        const next = { ...previous };

        if (tag === 'b' || tag === 'strong') next.bold = true;
        if (tag === 'i' || tag === 'em') next.italics = true;
        if (tag === 'u') next.underline = true;

        styleStack.push(next);
    }

    return runs;
}

function htmlToDocxParagraphs(html) {
    const paragraphs = [];
    const blockRegex = /<(h[1-6]|p|div|li)[^>]*>([\s\S]*?)<\/\1>/gi;
    const headingMap = {
        h1: HeadingLevel.HEADING_1,
        h2: HeadingLevel.HEADING_2,
        h3: HeadingLevel.HEADING_3,
        h4: HeadingLevel.HEADING_4,
        h5: HeadingLevel.HEADING_5,
        h6: HeadingLevel.HEADING_6
    };

    let match;
    while ((match = blockRegex.exec(html || '')) !== null) {
        const tag = match[1].toLowerCase();
        const innerHtml = match[2] || '';
        const runs = parseInlineRuns(innerHtml);

        if (runs.length === 0) {
            const text = htmlToPlainText(innerHtml);
            if (!text) continue;
            runs.push(new TextRun(text));
        }

        if (tag === 'li') {
            paragraphs.push(new Paragraph({
                children: runs,
                bullet: { level: 0 }
            }));
            continue;
        }

        if (headingMap[tag]) {
            paragraphs.push(new Paragraph({
                children: runs,
                heading: headingMap[tag]
            }));
            continue;
        }

        paragraphs.push(new Paragraph({ children: runs }));
    }

    if (paragraphs.length === 0) {
        const fallback = htmlToPlainText(html || '');
        paragraphs.push(new Paragraph(fallback || ''));
    }

    return paragraphs;
}

async function saveGoogleDocContent(fileId, html) {
    const docs = await getDocsClient();
    const plainText = htmlToPlainText(html || '');
    const doc = await docs.documents.get({ documentId: fileId });
    const endIndex = (doc?.data?.body?.content || [])
        .filter(c => c.paragraph || c.table)
        .reduce((max, c) => Math.max(max, c.endIndex || 0), 1);

    const requests = [];
    if (endIndex > 2) {
        requests.push({
            deleteContentRange: {
                range: { startIndex: 1, endIndex: endIndex - 1 }
            }
        });
    }

    if (plainText) {
        requests.push({
            insertText: {
                location: { index: 1 },
                text: plainText.endsWith('\n') ? plainText : `${plainText}\n`
            }
        });
    }

    if (requests.length > 0) {
        await docs.documents.batchUpdate({
            documentId: fileId,
            requestBody: { requests }
        });
    }
}

async function saveDocxContent(drive, fileId, html) {
    const paragraphs = htmlToDocxParagraphs(html || '');
    const doc = new Document({ sections: [{ children: paragraphs }] });
    const buffer = await Packer.toBuffer(doc);

    await drive.files.update({
        fileId,
        media: {
            mimeType: DOCX_MIME,
            body: Readable.from(buffer)
        }
    });
}

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

            // Persist word count analytics for Working DRAFT (used by dashboard refresh)
            try {
                const workingDraftId = process.env.GOOGLE_WORKING_DRAFT_ID;

                let workingDraft = null;
                if (workingDraftId) {
                    workingDraft = files.find(f => f?.id === workingDraftId) || null;
                    if (!workingDraft) {
                        try {
                            const metaRes = await drive.files.get({
                                fileId: workingDraftId,
                                fields: 'id,name,mimeType,modifiedTime'
                            });
                            const meta = metaRes?.data;
                            if (meta?.id) {
                                workingDraft = {
                                    id: meta.id,
                                    name: meta.name,
                                    mimeType: meta.mimeType,
                                    modifiedTime: meta.modifiedTime
                                };
                            }
                        } catch (e) {
                            context.warn('[Drive] Failed to load Working Draft metadata by ID:', e.message);
                        }
                    }
                }

                if (!workingDraft) {
                    workingDraft = files.find(f =>
                        (f?.mimeType === 'application/vnd.google-apps.document') &&
                        (typeof f?.name === 'string') &&
                        f.name.toLowerCase().includes('working draft')
                    ) || null;
                }

                if (workingDraft?.id && workingDraft?.mimeType === 'application/vnd.google-apps.document') {
                    const exportRes = await drive.files.export(
                        { fileId: workingDraft.id, mimeType: 'text/plain' },
                        { responseType: 'text' }
                    );

                    const wordCount = countWords(exportRes?.data);

                    await upsertItem(ANALYTICS_CONTAINER, {
                        id: WRITING_ANALYTICS_LATEST_ID,
                        type: 'writing_analytics',
                        generatedAt: new Date().toISOString(),
                        documents: [
                            {
                                id: workingDraft.id,
                                title: workingDraft.name,
                                wordCount,
                                modifiedTime: workingDraft.modifiedTime || null
                            }
                        ]
                    });
                }
            } catch (e) {
                context.warn('[Drive] Failed to upsert writing analytics:', e.message);
            }
            
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

// PUT /api/drive/file/{id} - Save edited content back to Drive (Google Docs or DOCX)
app.http('UpdateDriveFile', {
    methods: ['PUT'],
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

            const body = await request.json();
            const content = typeof body?.content === 'string' ? body.content : '';
            if (!content) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Content is required' })
                };
            }

            const drive = await getDriveClient();
            const meta = await drive.files.get({ fileId, fields: 'mimeType, name' });
            const mimeType = meta?.data?.mimeType;

            if (mimeType === GOOGLE_DOC_MIME) {
                await saveGoogleDocContent(fileId, content);
            } else if (mimeType === DOCX_MIME) {
                await saveDocxContent(drive, fileId, content);
            } else {
                return {
                    status: 415,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        error: 'Unsupported file type',
                        details: `Supported editor file types: Google Docs and DOCX. Found: ${mimeType || 'unknown'}`
                    })
                };
            }

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true, mimeType })
            };
        } catch (error) {
            context.error('Update Drive File Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to save drive file', details: error.message })
            };
        }
    }
});

// GET /api/drive/file/{id} - Fetch a Google Doc or DOCX file as HTML
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

            let html = '';

            if (mimeType === GOOGLE_DOC_MIME) {
                const response = await drive.files.export(
                    { fileId, mimeType: 'text/html' },
                    { responseType: 'text' }
                );
                html = response.data;
            } else if (mimeType === DOCX_MIME) {
                const response = await drive.files.get(
                    { fileId, alt: 'media' },
                    { responseType: 'arraybuffer' }
                );
                const buffer = Buffer.from(response.data);
                const converted = await mammoth.convertToHtml({ buffer });
                html = converted.value || '';
            } else {
                return {
                    status: 415,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        error: 'Unsupported file type',
                        details: `Supported editor file types: Google Docs and DOCX. Found: ${mimeType || 'unknown'}`
                    })
                };
            }

            return {
                status: 200,
                headers: { 'Content-Type': 'text/html; charset=utf-8' },
                body: html
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

// GET /api/drive/file/{id}/raw - Stream the authenticated original for read-only rendering
app.http('GetDriveFileRaw', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'drive/file/{id}/raw',
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
            if (mimeType !== DOCX_MIME && mimeType !== 'application/msword' && mimeType !== 'application/pdf') {
                return {
                    status: 415,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Raw preview is only available for Word documents and PDFs' })
                };
            }

            const response = await drive.files.get(
                { fileId, alt: 'media' },
                { responseType: 'arraybuffer' }
            );
            const safeName = String(meta?.data?.name || 'document').replace(/["\r\n]/g, '');

            return {
                status: 200,
                headers: {
                    'Content-Type': mimeType,
                    'Content-Disposition': `inline; filename="${safeName}"`,
                    'Cache-Control': 'private, max-age=300'
                },
                body: Buffer.from(response.data)
            };
        } catch (error) {
            context.error('Get Raw Drive File Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to fetch raw drive file', details: error.message })
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
