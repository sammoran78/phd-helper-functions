const { BlobServiceClient } = require('@azure/storage-blob');

let blobServiceClient = null;

function getBlobServiceClient() {
    if (!blobServiceClient) {
        const connectionString = process.env.BLOB_STORAGE_CONNECTION_STRING;
        if (!connectionString) {
            throw new Error('BLOB_STORAGE_CONNECTION_STRING environment variable is not set');
        }
        blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    }
    return blobServiceClient;
}

function getContainerClient(containerName) {
    const serviceClient = getBlobServiceClient();
    return serviceClient.getContainerClient(containerName);
}

async function uploadBlob(containerName, blobName, buffer, contentType = 'application/octet-stream') {
    const containerClient = getContainerClient(containerName);
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    
    await blockBlobClient.upload(buffer, buffer.length, {
        blobHTTPHeaders: {
            blobContentType: contentType
        }
    });
    
    return blockBlobClient.url;
}

async function downloadBlob(containerName, blobName) {
    const containerClient = getContainerClient(containerName);
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    
    const downloadResponse = await blockBlobClient.download(0);
    const chunks = [];
    
    for await (const chunk of downloadResponse.readableStreamBody) {
        chunks.push(chunk);
    }
    
    return Buffer.concat(chunks);
}

async function deleteBlob(containerName, blobName) {
    const containerClient = getContainerClient(containerName);
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    
    await blockBlobClient.delete();
    return { success: true };
}

async function blobExists(containerName, blobName) {
    const containerClient = getContainerClient(containerName);
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    
    return await blockBlobClient.exists();
}

async function listBlobs(containerName, prefix = '') {
    const containerClient = getContainerClient(containerName);
    const blobs = [];
    
    for await (const blob of containerClient.listBlobsFlat({ prefix })) {
        blobs.push({
            name: blob.name,
            url: `${containerClient.url}/${blob.name}`,
            size: blob.properties.contentLength,
            lastModified: blob.properties.lastModified
        });
    }
    
    return blobs;
}

module.exports = {
    getBlobServiceClient,
    getContainerClient,
    uploadBlob,
    downloadBlob,
    deleteBlob,
    blobExists,
    listBlobs
};
