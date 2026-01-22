const { CosmosClient } = require('@azure/cosmos');

let cosmosClient = null;
let database = null;
let containers = {};

function getCosmosClient() {
    if (!cosmosClient) {
        const connectionString = process.env.COSMOSDB_CONNECTION_STRING;
        if (!connectionString) {
            throw new Error('COSMOSDB_CONNECTION_STRING environment variable is not set');
        }
        cosmosClient = new CosmosClient(connectionString);
    }
    return cosmosClient;
}

function getDatabase() {
    if (!database) {
        const client = getCosmosClient();
        const databaseName = process.env.COSMOSDB_DATABASE_NAME || 'phd-helper';
        database = client.database(databaseName);
    }
    return database;
}

function getContainer(containerName) {
    if (!containers[containerName]) {
        const db = getDatabase();
        containers[containerName] = db.container(containerName);
    }
    return containers[containerName];
}

async function queryItems(containerName, querySpec) {
    const container = getContainer(containerName);
    const { resources } = await container.items.query(querySpec).fetchAll();
    return resources;
}

async function getItem(containerName, id, partitionKey) {
    const container = getContainer(containerName);
    try {
        const { resource } = await container.item(id, partitionKey).read();
        return resource;
    } catch (error) {
        if (error.code === 404) {
            return null;
        }
        throw error;
    }
}

async function createItem(containerName, item) {
    const container = getContainer(containerName);
    const { resource } = await container.items.create(item);
    return resource;
}

async function upsertItem(containerName, item) {
    const container = getContainer(containerName);
    const { resource } = await container.items.upsert(item);
    return resource;
}

async function deleteItem(containerName, id, partitionKey) {
    const container = getContainer(containerName);
    await container.item(id, partitionKey).delete();
    return { success: true };
}

async function replaceItem(containerName, id, partitionKey, item) {
    const container = getContainer(containerName);
    const { resource } = await container.item(id, partitionKey).replace(item);
    return resource;
}

module.exports = {
    getCosmosClient,
    getDatabase,
    getContainer,
    queryItems,
    getItem,
    createItem,
    upsertItem,
    deleteItem,
    replaceItem
};
