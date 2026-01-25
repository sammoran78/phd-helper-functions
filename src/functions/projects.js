const { app } = require('@azure/functions');
const { queryItems, upsertItem, deleteItem } = require('../../shared/cosmosClient');

const CONTAINER_NAME = process.env.COSMOSDB_CONTAINER_PROJECTS || 'projects';

function normalizeId(value) {
    if (value === undefined || value === null) return '';
    return typeof value === 'string' ? value : String(value);
}

function parseId(value) {
    if (value === undefined || value === null) return value;
    if (typeof value === 'number') return value;
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? value : parsed;
}

function toClientItem(item) {
    if (!item || typeof item !== 'object') return item;
    return {
        ...item,
        id: parseId(item.id)
    };
}

// GET /api/projects - Load all project planner data
app.http('GetProjects', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'projects',
    handler: async (request, context) => {
        try {
            context.log('Loading projects from CosmosDB');

            const [tasks, subProjects] = await Promise.all([
                queryItems(CONTAINER_NAME, { query: 'SELECT * FROM c WHERE c.type = "task"' }),
                queryItems(CONTAINER_NAME, { query: 'SELECT * FROM c WHERE c.type = "subproject"' })
            ]);

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tasks: tasks.map(toClientItem),
                    subProjects: subProjects.map(toClientItem)
                })
            };
        } catch (error) {
            context.error('Get Projects Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to load projects', details: error.message })
            };
        }
    }
});

// POST /api/projects/task - Create or update a task
app.http('UpsertProjectTask', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'projects/task',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const rawId = body.id ?? Date.now();
            const id = normalizeId(rawId);

            if (!id) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Task id is required' })
                };
            }

            const task = {
                ...body,
                id,
                type: 'task',
                updatedAt: new Date().toISOString(),
                createdAt: body.createdAt || new Date().toISOString()
            };

            const saved = await upsertItem(CONTAINER_NAME, task);

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true, task: toClientItem(saved) })
            };
        } catch (error) {
            context.error('Save Task Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to save task', details: error.message })
            };
        }
    }
});

// DELETE /api/projects/task/{id} - Delete a task
app.http('DeleteProjectTask', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'projects/task/{id}',
    handler: async (request, context) => {
        try {
            const id = normalizeId(request.params.id);
            if (!id) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Task id is required' })
                };
            }

            await deleteItem(CONTAINER_NAME, id, id);

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true })
            };
        } catch (error) {
            context.error('Delete Task Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to delete task', details: error.message })
            };
        }
    }
});

// POST /api/projects/subproject - Create or update a subproject
app.http('UpsertSubProject', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'projects/subproject',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const rawId = body.id ?? Date.now();
            const id = normalizeId(rawId);

            if (!id) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Subproject id is required' })
                };
            }

            const subProject = {
                ...body,
                id,
                type: 'subproject',
                updatedAt: new Date().toISOString(),
                createdAt: body.createdAt || new Date().toISOString()
            };

            const saved = await upsertItem(CONTAINER_NAME, subProject);

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true, subProject: toClientItem(saved) })
            };
        } catch (error) {
            context.error('Save SubProject Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to save subproject', details: error.message })
            };
        }
    }
});

// DELETE /api/projects/subproject/{id} - Delete a subproject
app.http('DeleteSubProject', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'projects/subproject/{id}',
    handler: async (request, context) => {
        try {
            const id = normalizeId(request.params.id);
            if (!id) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Subproject id is required' })
                };
            }

            await deleteItem(CONTAINER_NAME, id, id);

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true })
            };
        } catch (error) {
            context.error('Delete SubProject Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to delete subproject', details: error.message })
            };
        }
    }
});
