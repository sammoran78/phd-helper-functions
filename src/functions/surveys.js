/**
 * Survey Results Azure Functions
 * Fetch survey responses from Qualtrics API
 */

const { app } = require('@azure/functions');
const AdmZip = require('adm-zip');

const QUALTRICS_API_TOKEN = process.env.QUALTRICS_API_TOKEN;
const QUALTRICS_DATA_CENTER = process.env.QUALTRICS_DATA_CENTER || 'sjc1';
const QUALTRICS_SURVEY_ID = process.env.QUALTRICS_SURVEY_ID;

function buildQualtricsHeaders() {
    return {
        'X-API-TOKEN': QUALTRICS_API_TOKEN,
        'Content-Type': 'application/json'
    };
}

function getQualtricsApiBase() {
    return `https://${QUALTRICS_DATA_CENTER}.qualtrics.com/API/v3`;
}

async function qualtricsFetch(path, options = {}) {
    const url = `${getQualtricsApiBase()}${path}`;
    return fetch(url, {
        ...options,
        headers: {
            ...buildQualtricsHeaders(),
            ...(options.headers || {})
        }
    });
}

function notConfiguredResponse() {
    return {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            error: 'Qualtrics API token not configured'
        })
    };
}

// GET /api/surveys - List all available surveys from Qualtrics
app.http('ListSurveys', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'surveys',
    handler: async (request, context) => {
        try {
            if (!QUALTRICS_API_TOKEN) {
                return {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        configured: false,
                        error: 'Qualtrics API token not configured'
                    })
                };
            }

            // Fetch all surveys from Qualtrics API
            context.log(`Fetching surveys list from Qualtrics (${QUALTRICS_DATA_CENTER})`);

            const response = await qualtricsFetch('/surveys', { method: 'GET' });

            if (!response.ok) {
                const errorText = await response.text();
                context.error('Qualtrics API error:', response.status, errorText);
                return {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        configured: true,
                        datacenter: QUALTRICS_DATA_CENTER,
                        error: 'Failed to fetch surveys',
                        details: errorText
                    })
                };
            }

            const data = await response.json();
            const surveys = (data.result?.elements || []).map(s => ({
                id: s.id,
                name: s.name,
                isActive: s.isActive,
                creationDate: s.creationDate,
                lastModified: s.lastModified,
                responseCounts: s.responseCounts
            }));
            
            context.log(`Retrieved ${surveys.length} surveys from Qualtrics`);
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    configured: true,
                    datacenter: QUALTRICS_DATA_CENTER,
                    surveys
                })
            };
        } catch (error) {
            context.error('List Surveys Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    configured: true,
                    error: 'Failed to list surveys',
                    details: error.message
                })
            };
        }
    }
});

// GET /api/surveys/:surveyId/responses - Get responses for a specific survey
app.http('GetSurveyResponsesById', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'surveys/{surveyId}/responses',
    handler: async (request, context) => {
        try {
            if (!QUALTRICS_API_TOKEN) {
                return notConfiguredResponse();
            }

            const surveyId = request.params.surveyId;

            context.log(`Fetching responses for survey: ${surveyId}`);

            const response = await qualtricsFetch(`/surveys/${encodeURIComponent(surveyId)}/responses`, { method: 'GET' });

            if (!response.ok) {
                const errorText = await response.text();
                return {
                    status: response.status,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        error: 'Failed to fetch responses',
                        details: errorText
                    })
                };
            }

            const data = await response.json();
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data.result || {})
            };
        } catch (error) {
            context.error('Get Survey Responses By ID Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    error: 'Failed to retrieve survey responses',
                    details: error.message
                })
            };
        }
    }
});

// GET /api/surveys/responses - Get survey responses from Qualtrics
app.http('GetSurveyResponses', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'surveys/responses',
    handler: async (request, context) => {
        try {
            if (!QUALTRICS_API_TOKEN || !QUALTRICS_SURVEY_ID) {
                return {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        error: 'Qualtrics configuration missing',
                        details: 'Set QUALTRICS_API_TOKEN and QUALTRICS_SURVEY_ID environment variables'
                    })
                };
            }

            context.log(`Fetching survey responses from Qualtrics: ${QUALTRICS_SURVEY_ID}`);

            const response = await qualtricsFetch(`/surveys/${encodeURIComponent(QUALTRICS_SURVEY_ID)}/responses`, { method: 'GET' });

            if (!response.ok) {
                const errorText = await response.text();
                context.error('Qualtrics API error:', response.status, errorText);
                return {
                    status: response.status,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        error: 'Failed to fetch from Qualtrics',
                        details: errorText
                    })
                };
            }

            const data = await response.json();
            
            context.log(`Retrieved ${data.result?.responses?.length || 0} survey responses`);
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data.result || {})
            };
        } catch (error) {
            context.error('Get Survey Responses Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    error: 'Failed to retrieve survey responses',
                    details: error.message
                })
            };
        }
    }
});

// GET /api/surveys/summary - Get survey summary statistics
app.http('GetSurveySummary', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'surveys/summary',
    handler: async (request, context) => {
        try {
            if (!QUALTRICS_API_TOKEN || !QUALTRICS_SURVEY_ID) {
                return {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        error: 'Qualtrics configuration missing'
                    })
                };
            }

            const response = await qualtricsFetch(`/surveys/${encodeURIComponent(QUALTRICS_SURVEY_ID)}`, { method: 'GET' });

            if (!response.ok) {
                const errorText = await response.text();
                return {
                    status: response.status,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        error: 'Failed to fetch survey metadata',
                        details: errorText
                    })
                };
            }

            const data = await response.json();
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data.result || {})
            };
        } catch (error) {
            context.error('Get Survey Summary Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    error: 'Failed to retrieve survey summary',
                    details: error.message
                })
            };
        }
    }
});

app.http('StartQualtricsSurveyExport', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'qualtrics/surveys/{surveyId}/export',
    handler: async (request, context) => {
        try {
            if (!QUALTRICS_API_TOKEN) return notConfiguredResponse();

            const surveyId = request.params.surveyId;
            const body = await request.json().catch(() => ({}));
            const format = body?.format ? String(body.format).toLowerCase() : 'json';
            const useLabels = typeof body?.useLabels === 'boolean' ? body.useLabels : true;
            const exportOptions = { format };

            if (format !== 'json' && format !== 'ndjson') {
                exportOptions.useLabels = useLabels;
            }

            const response = await qualtricsFetch(
                `/surveys/${encodeURIComponent(surveyId)}/export-responses`,
                {
                    method: 'POST',
                    body: JSON.stringify(exportOptions)
                }
            );
            const json = await response.json().catch(() => ({}));

            if (!response.ok) {
                return {
                    status: response.status,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Qualtrics API error', details: json })
                };
            }

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ progressId: json?.result?.progressId || null })
            };
        } catch (error) {
            context.error('Start Qualtrics Survey Export Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to start Qualtrics export', details: error.message })
            };
        }
    }
});

app.http('GetQualtricsSurveyExportProgress', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'qualtrics/surveys/{surveyId}/export/{progressId}',
    handler: async (request, context) => {
        try {
            if (!QUALTRICS_API_TOKEN) return notConfiguredResponse();

            const surveyId = request.params.surveyId;
            const progressId = request.params.progressId;
            const response = await qualtricsFetch(
                `/surveys/${encodeURIComponent(surveyId)}/export-responses/${encodeURIComponent(progressId)}`,
                { method: 'GET' }
            );
            const json = await response.json().catch(() => ({}));

            if (!response.ok) {
                return {
                    status: response.status,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Qualtrics API error', details: json })
                };
            }

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    status: json?.result?.status || null,
                    percentComplete: json?.result?.percentComplete ?? null,
                    fileId: json?.result?.fileId || null
                })
            };
        } catch (error) {
            context.error('Get Qualtrics Survey Export Progress Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to get export progress', details: error.message })
            };
        }
    }
});

app.http('DownloadQualtricsSurveyExportJson', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'qualtrics/surveys/{surveyId}/export-file/{fileId}/json',
    handler: async (request, context) => {
        try {
            if (!QUALTRICS_API_TOKEN) return notConfiguredResponse();

            const surveyId = request.params.surveyId;
            const fileId = request.params.fileId;
            const response = await qualtricsFetch(
                `/surveys/${encodeURIComponent(surveyId)}/export-responses/${encodeURIComponent(fileId)}/file`,
                { method: 'GET', headers: { 'Content-Type': 'application/octet-stream' } }
            );

            if (!response.ok) {
                const json = await response.json().catch(() => ({}));
                return {
                    status: response.status,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Qualtrics API error', details: json })
                };
            }

            const arrayBuffer = await response.arrayBuffer();
            const zip = new AdmZip(Buffer.from(arrayBuffer));
            const jsonEntry = zip.getEntries().find((entry) => entry.entryName.endsWith('.json'));

            if (!jsonEntry) {
                return {
                    status: 404,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'No JSON file found in export zip' })
                };
            }

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: jsonEntry.getData().toString('utf8')
            };
        } catch (error) {
            context.error('Download Qualtrics Survey Export JSON Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to download export JSON', details: error.message })
            };
        }
    }
});

module.exports = { app };
