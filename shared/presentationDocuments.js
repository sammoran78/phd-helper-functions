const crypto = require('crypto');

const MAX_PRESENTATION_BYTES = 1_800_000;
const MAX_REVISIONS = 50;

function readHeader(request, name) {
    return request.headers?.get?.(name) || request.headers?.[name] || null;
}

function getPresentationOwner(request) {
    const encodedPrincipal = readHeader(request, 'x-ms-client-principal');
    if (encodedPrincipal) {
        try {
            const principal = JSON.parse(Buffer.from(encodedPrincipal, 'base64').toString('utf8'));
            if (principal.userId) return `user:${principal.userId}`;
        } catch {
            // Ignore a malformed platform header and fall back to the workspace capability.
        }
    }
    const workspace = readHeader(request, 'x-presenter-workspace');
    if (workspace && /^[a-zA-Z0-9-]{20,100}$/.test(workspace)) return `workspace:${workspace}`;
    return null;
}

function hashId(...parts) {
    return crypto.createHash('sha256').update(parts.join('\u001f')).digest('hex');
}

function currentDocumentId(ownerId, projectId) {
    return `presentation-${hashId(ownerId, projectId)}`;
}

function revisionDocumentId(ownerId, projectId, revision) {
    return `presentation-revision-${hashId(ownerId, projectId, String(revision))}`;
}

function validateProject(project, routeProjectId) {
    if (!project || typeof project !== 'object' || Array.isArray(project)) throw new Error('A presentation project object is required');
    if (typeof project.id !== 'string' || !project.id.trim()) throw new Error('The presentation project must have an id');
    if (project.id !== routeProjectId) throw new Error('The route id must match the presentation project id');
    if (Buffer.byteLength(JSON.stringify(project), 'utf8') > MAX_PRESENTATION_BYTES) {
        throw new Error(`Presentation exceeds the ${MAX_PRESENTATION_BYTES}-byte storage limit`);
    }
    return project;
}

function makeCurrentDocument(ownerId, project, revision, now = new Date().toISOString()) {
    return {
        id: currentDocumentId(ownerId, project.id), type: 'presentation', ownerId, projectId: project.id,
        revision, project, updatedAt: now, createdAt: project.createdAt || now
    };
}

function makeRevisionDocument(ownerId, project, revision, now = new Date().toISOString()) {
    return {
        id: revisionDocumentId(ownerId, project.id, revision), type: 'presentation-revision', ownerId,
        projectId: project.id, revision, project, createdAt: now
    };
}

module.exports = {
    MAX_REVISIONS, getPresentationOwner, currentDocumentId, revisionDocumentId, validateProject,
    makeCurrentDocument, makeRevisionDocument
};
