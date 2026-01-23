/**
 * Full Migration Script: Transfer references.json to CosmosDB + PDFs to Blob Storage
 * 
 * This script:
 * 1. Reads references.json
 * 2. For each reference with files, uploads PDFs to Azure Blob Storage
 * 3. Updates the file URLs to point to blob storage
 * 4. Upserts the reference to CosmosDB
 * 
 * Usage:
 * 1. Set environment variables (see below)
 * 2. Run: node scripts/migrate-full.js
 * 
 * Required Environment Variables:
 *   COSMOSDB_CONNECTION_STRING - CosmosDB connection string
 *   BLOB_STORAGE_CONNECTION_STRING - Azure Blob Storage connection string
 *   COSMOSDB_DATABASE_NAME - Database name (default: phd-helper)
 *   COSMOSDB_CONTAINER_REFERENCES - Container name (default: references)
 *   BLOB_CONTAINER_UPLOADS - Blob container name (default: uploads)
 */

const { CosmosClient } = require('@azure/cosmos');
const { BlobServiceClient } = require('@azure/storage-blob');
const fs = require('fs');
const path = require('path');

// Load environment variables from .env if available
try {
    require('dotenv').config();
} catch (e) {
    console.log('dotenv not available, using process.env directly');
}

// Configuration
const REFERENCES_JSON_PATH = '/Users/sammoran/Documents/GitHub/phd-helper-cloud/references.json';
const UPLOADS_DIR = '/Users/sammoran/Library/CloudStorage/GoogleDrive-samoran@gmail.com/My Drive/Education/Macquarie University/PhD/Literature Corpus';

async function migrate() {
    console.log('=== Full Migration Script ===\n');
    console.log('This will migrate references.json to CosmosDB and upload PDFs to Blob Storage.\n');
    
    // Validate environment variables
    const cosmosConnectionString = process.env.COSMOSDB_CONNECTION_STRING;
    const blobConnectionString = process.env.BLOB_STORAGE_CONNECTION_STRING;
    const databaseName = process.env.COSMOSDB_DATABASE_NAME || 'phd-helper';
    const containerName = process.env.COSMOSDB_CONTAINER_REFERENCES || 'references';
    const blobContainerName = process.env.BLOB_CONTAINER_UPLOADS || 'uploads';
    
    if (!cosmosConnectionString) {
        throw new Error('COSMOSDB_CONNECTION_STRING environment variable is required');
    }
    if (!blobConnectionString) {
        throw new Error('BLOB_STORAGE_CONNECTION_STRING environment variable is required');
    }
    
    console.log(`CosmosDB Database: ${databaseName}`);
    console.log(`CosmosDB Container: ${containerName}`);
    console.log(`Blob Container: ${blobContainerName}`);
    console.log(`References JSON: ${REFERENCES_JSON_PATH}`);
    console.log(`Local Uploads Dir: ${UPLOADS_DIR}\n`);
    
    // Read references.json
    if (!fs.existsSync(REFERENCES_JSON_PATH)) {
        throw new Error(`File not found: ${REFERENCES_JSON_PATH}`);
    }
    
    const fileContent = fs.readFileSync(REFERENCES_JSON_PATH, 'utf8');
    const references = JSON.parse(fileContent);
    
    console.log(`Loaded ${references.length} references from JSON file\n`);
    
    // Connect to CosmosDB
    const cosmosClient = new CosmosClient(cosmosConnectionString);
    const database = cosmosClient.database(databaseName);
    const container = database.container(containerName);
    
    console.log('Connected to CosmosDB');
    
    // Connect to Blob Storage
    const blobServiceClient = BlobServiceClient.fromConnectionString(blobConnectionString);
    const blobContainerClient = blobServiceClient.getContainerClient(blobContainerName);
    
    // Ensure blob container exists
    await blobContainerClient.createIfNotExists();
    console.log('Connected to Blob Storage\n');
    
    // Migration stats
    let refSuccess = 0;
    let refError = 0;
    let fileSuccess = 0;
    let fileError = 0;
    let fileSkipped = 0;
    const errors = [];
    
    // Process each reference
    for (let i = 0; i < references.length; i++) {
        const ref = references[i];
        
        try {
            // Ensure the reference has an id
            if (!ref.id) {
                console.warn(`Reference at index ${i} has no id, generating one...`);
                ref.id = `ref_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            }
            
            // Process files if present
            if (ref.files && Array.isArray(ref.files) && ref.files.length > 0) {
                const updatedFiles = [];
                
                for (const file of ref.files) {
                    try {
                        // Extract local filename from URL like /uploads/1765358734282_filename.pdf
                        const localFileName = file.url.replace('/uploads/', '');
                        const localFilePath = path.join(UPLOADS_DIR, decodeURIComponent(localFileName));
                        
                        if (!fs.existsSync(localFilePath)) {
                            console.warn(`  File not found: ${localFilePath}`);
                            fileSkipped++;
                            // Keep original file entry but mark as not migrated
                            updatedFiles.push({
                                ...file,
                                migrationNote: 'File not found on disk'
                            });
                            continue;
                        }
                        
                        // Read file
                        const fileBuffer = fs.readFileSync(localFilePath);
                        
                        // Generate blob name (use same name as local)
                        const blobName = localFileName;
                        
                        // Upload to blob storage
                        const blockBlobClient = blobContainerClient.getBlockBlobClient(blobName);
                        
                        // Determine content type
                        let contentType = 'application/octet-stream';
                        if (localFileName.toLowerCase().endsWith('.pdf')) {
                            contentType = 'application/pdf';
                        } else if (localFileName.toLowerCase().endsWith('.docx')) {
                            contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
                        }
                        
                        await blockBlobClient.upload(fileBuffer, fileBuffer.length, {
                            blobHTTPHeaders: { blobContentType: contentType }
                        });
                        
                        const blobUrl = blockBlobClient.url;
                        
                        console.log(`  Uploaded: ${file.name} -> ${blobName}`);
                        fileSuccess++;
                        
                        // Update file entry with blob info
                        updatedFiles.push({
                            name: file.name,
                            url: blobUrl,
                            blobName: blobName
                        });
                        
                    } catch (fileErr) {
                        console.error(`  Error uploading file ${file.name}:`, fileErr.message);
                        fileError++;
                        errors.push({
                            type: 'file',
                            refId: ref.id,
                            fileName: file.name,
                            error: fileErr.message
                        });
                        // Keep original file entry
                        updatedFiles.push(file);
                    }
                }
                
                // Update reference with new file URLs
                ref.files = updatedFiles;
            }
            
            // Upsert reference to CosmosDB
            await container.items.upsert(ref);
            refSuccess++;
            
            console.log(`[${i + 1}/${references.length}] Migrated: ${ref.title?.substring(0, 50) || ref.id}`);
            
        } catch (error) {
            refError++;
            errors.push({
                type: 'reference',
                index: i,
                id: ref.id,
                error: error.message
            });
            console.error(`[${i + 1}/${references.length}] Error migrating reference ${ref.id}:`, error.message);
        }
    }
    
    // Summary
    console.log('\n=== Migration Complete ===');
    console.log(`References: ${refSuccess} migrated, ${refError} errors`);
    console.log(`Files: ${fileSuccess} uploaded, ${fileSkipped} skipped, ${fileError} errors`);
    
    if (errors.length > 0) {
        console.log('\nErrors encountered:');
        errors.forEach(err => {
            if (err.type === 'reference') {
                console.log(`  - Reference ${err.id || `index ${err.index}`}: ${err.error}`);
            } else {
                console.log(`  - File "${err.fileName}" (ref: ${err.refId}): ${err.error}`);
            }
        });
    }
    
    console.log('\nMigration finished!');
}

// Run migration
migrate()
    .then(() => {
        console.log('\n✓ Script completed successfully');
        process.exit(0);
    })
    .catch(error => {
        console.error('\n✗ Migration failed:', error.message);
        console.error(error.stack);
        process.exit(1);
    });
