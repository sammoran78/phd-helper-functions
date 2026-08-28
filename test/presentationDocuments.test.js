const test = require('node:test');
const assert = require('node:assert/strict');
const {
    getPresentationOwner, currentDocumentId, revisionDocumentId, validateProject,
    makeCurrentDocument, makeRevisionDocument
} = require('../shared/presentationDocuments');

const requestWith = (headers = {}) => ({ headers: { get: (name) => headers[name] || null } });

test('Static Web Apps identity takes precedence over workspace capability', () => {
    const principal = Buffer.from(JSON.stringify({ userId: 'azure-user-1' })).toString('base64');
    assert.equal(getPresentationOwner(requestWith({
        'x-ms-client-principal': principal, 'x-presenter-workspace': '12345678-1234-1234-1234-123456789012'
    })), 'user:azure-user-1');
});

test('workspace capability supplies an owner for an anonymous app', () => {
    assert.equal(getPresentationOwner(requestWith({
        'x-presenter-workspace': '12345678-1234-1234-1234-123456789012'
    })), 'workspace:12345678-1234-1234-1234-123456789012');
    assert.equal(getPresentationOwner(requestWith()), null);
});

test('document ids are stable, scoped, and revision-specific', () => {
    const id = currentDocumentId('owner-a', 'deck');
    assert.equal(id, currentDocumentId('owner-a', 'deck'));
    assert.notEqual(id, currentDocumentId('owner-b', 'deck'));
    assert.notEqual(revisionDocumentId('owner-a', 'deck', 1), revisionDocumentId('owner-a', 'deck', 2));
});

test('projects are validated and documents preserve their revision', () => {
    const project = validateProject({ id: 'deck', name: 'Deck', slides: [] }, 'deck');
    const current = makeCurrentDocument('owner', project, 3, '2026-08-28T00:00:00.000Z');
    const revision = makeRevisionDocument('owner', project, 3, '2026-08-28T00:00:00.000Z');
    assert.equal(current.type, 'presentation');
    assert.equal(revision.type, 'presentation-revision');
    assert.equal(current.revision, 3);
    assert.equal(revision.project.name, 'Deck');
    assert.throws(() => validateProject(project, 'different'), /must match/);
});
