const { app } = require('@azure/functions');
const { queryItems, getItem, upsertItem, deleteItem } = require('../../shared/cosmosClient');
const {
    MAX_REVISIONS, getPresentationOwner, currentDocumentId, validateProject,
    makeCurrentDocument, makeRevisionDocument
} = require('../../shared/presentationDocuments');

const CONTAINER_NAME = process.env.COSMOSDB_CONTAINER_PRESENTATIONS || 'presentations';
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const json = (status, body) => ({ status, headers: JSON_HEADERS, body: JSON.stringify(body) });

function ownerOrResponse(request) {
    return getPresentationOwner(request) || json(401, { error: 'Presentation workspace identity is required' });
}

async function deleteDocuments(documents) {
    await Promise.all(documents.map((document) => deleteItem(CONTAINER_NAME, document.id, document.id)));
}

app.http('GetPresentations', {
    methods: ['GET'], authLevel: 'anonymous', route: 'presentations',
    handler: async (request, context) => {
        try {
            const owner = ownerOrResponse(request);
            if (typeof owner !== 'string') return owner;
            const documents = await queryItems(CONTAINER_NAME, {
                query: 'SELECT * FROM c WHERE c.type = @type AND c.ownerId = @ownerId ORDER BY c.updatedAt DESC',
                parameters: [{ name: '@type', value: 'presentation' }, { name: '@ownerId', value: owner }]
            });
            return json(200, { presentations: documents.map(({ project, revision, updatedAt }) => ({ project, revision, updatedAt })) });
        } catch (error) {
            context.error('Get Presentations Error:', error);
            return json(500, { error: 'Failed to load presentations' });
        }
    }
});

app.http('PutPresentation', {
    methods: ['PUT'], authLevel: 'anonymous', route: 'presentations/{id}',
    handler: async (request, context) => {
        try {
            const owner = ownerOrResponse(request);
            if (typeof owner !== 'string') return owner;
            const projectId = request.params.id;
            const project = validateProject(await request.json(), projectId);
            const currentId = currentDocumentId(owner, projectId);
            const current = await getItem(CONTAINER_NAME, currentId, currentId);
            const revision = (current?.revision || 0) + 1;
            const now = new Date().toISOString();
            const [saved] = await Promise.all([
                upsertItem(CONTAINER_NAME, makeCurrentDocument(owner, project, revision, now)),
                upsertItem(CONTAINER_NAME, makeRevisionDocument(owner, project, revision, now))
            ]);
            const revisions = await queryItems(CONTAINER_NAME, {
                query: 'SELECT c.id, c.revision FROM c WHERE c.type = @type AND c.ownerId = @ownerId AND c.projectId = @projectId ORDER BY c.revision DESC',
                parameters: [
                    { name: '@type', value: 'presentation-revision' }, { name: '@ownerId', value: owner },
                    { name: '@projectId', value: projectId }
                ]
            });
            if (revisions.length > MAX_REVISIONS) await deleteDocuments(revisions.slice(MAX_REVISIONS));
            return json(200, { success: true, revision: saved.revision, updatedAt: saved.updatedAt });
        } catch (error) {
            context.error('Save Presentation Error:', error);
            const status = /required|must match|exceeds/.test(error.message) ? 400 : 500;
            return json(status, { error: status === 400 ? error.message : 'Failed to save presentation' });
        }
    }
});

app.http('DeletePresentation', {
    methods: ['DELETE'], authLevel: 'anonymous', route: 'presentations/{id}',
    handler: async (request, context) => {
        try {
            const owner = ownerOrResponse(request);
            if (typeof owner !== 'string') return owner;
            const projectId = request.params.id;
            const currentId = currentDocumentId(owner, projectId);
            const revisions = await queryItems(CONTAINER_NAME, {
                query: 'SELECT c.id FROM c WHERE c.type = @type AND c.ownerId = @ownerId AND c.projectId = @projectId',
                parameters: [
                    { name: '@type', value: 'presentation-revision' }, { name: '@ownerId', value: owner },
                    { name: '@projectId', value: projectId }
                ]
            });
            const current = await getItem(CONTAINER_NAME, currentId, currentId);
            await deleteDocuments(current ? [current, ...revisions] : revisions);
            return json(200, { success: true });
        } catch (error) {
            context.error('Delete Presentation Error:', error);
            return json(500, { error: 'Failed to delete presentation' });
        }
    }
});

app.http('GetPresentationRevisions', {
    methods: ['GET'], authLevel: 'anonymous', route: 'presentations/{id}/revisions',
    handler: async (request, context) => {
        try {
            const owner = ownerOrResponse(request);
            if (typeof owner !== 'string') return owner;
            const revisions = await queryItems(CONTAINER_NAME, {
                query: 'SELECT c.revision, c.createdAt, c.project FROM c WHERE c.type = @type AND c.ownerId = @ownerId AND c.projectId = @projectId ORDER BY c.revision DESC',
                parameters: [
                    { name: '@type', value: 'presentation-revision' }, { name: '@ownerId', value: owner },
                    { name: '@projectId', value: request.params.id }
                ]
            });
            return json(200, { revisions });
        } catch (error) {
            context.error('Get Presentation Revisions Error:', error);
            return json(500, { error: 'Failed to load presentation revisions' });
        }
    }
});
