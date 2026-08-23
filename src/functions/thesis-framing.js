const { app } = require('@azure/functions');
const { verifyDashboardConfigEditor, verifyDashboardRequest } = require('../../shared/requestAuth');
const { getThesisFraming, saveThesisFraming } = require('../../shared/thesisFraming');

const json = (status, payload) => ({
    status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
});

app.http('GetThesisFraming', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'thesis/framing',
    handler: async (request, context) => {
        if (!verifyDashboardRequest(request)) return json(401, { error: 'Unauthorized' });
        try {
            return json(200, await getThesisFraming());
        } catch (error) {
            context.error('Get Thesis Framing Error:', error);
            return json(500, { error: 'Failed to load thesis framing', details: error.message });
        }
    }
});

app.http('UpdateThesisFraming', {
    methods: ['PUT'],
    authLevel: 'anonymous',
    route: 'thesis/framing',
    handler: async (request, context) => {
        if (!verifyDashboardRequest(request)) return json(401, { error: 'Unauthorized' });
        if (!verifyDashboardConfigEditor(request)) return json(403, { error: 'Forbidden' });
        try {
            return json(200, await saveThesisFraming(await request.json()));
        } catch (error) {
            const status = error?.status === 400 ? 400 : 500;
            if (status === 500) context.error('Update Thesis Framing Error:', error);
            return json(status, {
                error: status === 400 ? error.message : 'Failed to update thesis framing',
                ...(status === 500 ? { details: error.message } : {})
            });
        }
    }
});
