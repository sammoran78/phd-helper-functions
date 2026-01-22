/**
 * Migration Script: Transfer references.json to CosmosDB
 * 
 * Usage:
 * 1. Set environment variables in .env file or export them
 * 2. Run: node scripts/migrate-references.js <path-to-references.json>
 */

const { CosmosClient } = require('@azure/cosmos');
const fs = require('fs');
const path = require('path');

// Load environment variables from .env if available
try {
    require('dotenv').config();
} catch (e) {
    console.log('dotenv not available, using process.env directly');
}

async function migrateReferences(jsonFilePath) {
    console.log('=== CosmosDB Migration Script ===\n');
    
    // Validate environment variables
    const connectionString = process.env.COSMOSDB_CONNECTION_STRING;
    const databaseName = process.env.COSMOSDB_DATABASE_NAME || 'phd-helper';
    const containerName = process.env.COSMOSDB_CONTAINER_REFERENCES || 'references';
    
    if (!connectionString) {
        throw new Error('COSMOSDB_CONNECTION_STRING environment variable is required');
    }
    
    console.log(`Database: ${databaseName}`);
    console.log(`Container: ${containerName}`);
    console.log(`Source file: ${jsonFilePath}\n`);
    
    // Read references.json
    if (!fs.existsSync(jsonFilePath)) {
        throw new Error(`File not found: ${jsonFilePath}`);
    }
    
    const fileContent = fs.readFileSync(jsonFilePath, 'utf8');
    const references = JSON.parse(fileContent);
    
    console.log(`Loaded ${references.length} references from JSON file\n`);
    
    // Connect to CosmosDB
    const client = new CosmosClient(connectionString);
    const database = client.database(databaseName);
    const container = database.container(containerName);
    
    console.log('Connected to CosmosDB\n');
    
    // Migrate each reference
    let successCount = 0;
    let errorCount = 0;
    const errors = [];
    
    for (let i = 0; i < references.length; i++) {
        const ref = references[i];
        
        try {
            // Ensure the reference has an id
            if (!ref.id) {
                console.warn(`Reference at index ${i} has no id, skipping...`);
                errorCount++;
                errors.push({ index: i, error: 'No id field' });
                continue;
            }
            
            // Upsert the reference (create or update)
            await container.items.upsert(ref);
            successCount++;
            
            if ((i + 1) % 100 === 0) {
                console.log(`Progress: ${i + 1}/${references.length} references processed...`);
            }
        } catch (error) {
            errorCount++;
            errors.push({ 
                index: i, 
                id: ref.id, 
                error: error.message 
            });
            console.error(`Error migrating reference ${ref.id}:`, error.message);
        }
    }
    
    console.log('\n=== Migration Complete ===');
    console.log(`✓ Successfully migrated: ${successCount}`);
    console.log(`✗ Errors: ${errorCount}`);
    
    if (errors.length > 0) {
        console.log('\nErrors encountered:');
        errors.forEach(err => {
            console.log(`  - Index ${err.index}${err.id ? ` (ID: ${err.id})` : ''}: ${err.error}`);
        });
    }
    
    console.log('\nMigration finished!');
}

// Main execution
const args = process.argv.slice(2);
if (args.length === 0) {
    console.error('Usage: node migrate-references.js <path-to-references.json>');
    console.error('Example: node migrate-references.js ../phd-helper-cloud/references.json');
    process.exit(1);
}

const jsonFilePath = path.resolve(args[0]);

migrateReferences(jsonFilePath)
    .then(() => {
        console.log('\n✓ Script completed successfully');
        process.exit(0);
    })
    .catch(error => {
        console.error('\n✗ Migration failed:', error.message);
        console.error(error.stack);
        process.exit(1);
    });
