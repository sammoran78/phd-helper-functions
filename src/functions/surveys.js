/**
 * Survey Results Azure Functions
 * Fetch survey responses from Qualtrics API
 */

const { app } = require('@azure/functions');

const QUALTRICS_API_TOKEN = process.env.QUALTRICS_API_TOKEN;
const QUALTRICS_DATA_CENTER = process.env.QUALTRICS_DATA_CENTER || 'sjc1';
const QUALTRICS_SURVEY_ID = process.env.QUALTRICS_SURVEY_ID;

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
            const qualtricsUrl = `https://${QUALTRICS_DATA_CENTER}.qualtrics.com/API/v3/surveys`;
            
            context.log(`Fetching surveys list from Qualtrics (${QUALTRICS_DATA_CENTER})`);
            
            const response = await fetch(qualtricsUrl, {
                headers: {
                    'X-API-TOKEN': QUALTRICS_API_TOKEN,
                    'Content-Type': 'application/json'
                }
            });

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
                return {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        error: 'Qualtrics API token not configured'
                    })
                };
            }

            const surveyId = request.params.surveyId;
            
            // Fetch responses from Qualtrics API
            const qualtricsUrl = `https://${QUALTRICS_DATA_CENTER}.qualtrics.com/API/v3/surveys/${surveyId}/responses`;
            
            context.log(`Fetching responses for survey: ${surveyId}`);
            
            const response = await fetch(qualtricsUrl, {
                headers: {
                    'X-API-TOKEN': QUALTRICS_API_TOKEN,
                    'Content-Type': 'application/json'
                }
            });

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

            const url = new URL(request.url);
            const limit = url.searchParams.get('limit') || '100';
            
            // Fetch responses from Qualtrics API
            const qualtricsUrl = `https://${QUALTRICS_DATA_CENTER}.qualtrics.com/API/v3/surveys/${QUALTRICS_SURVEY_ID}/responses`;
            
            context.log(`Fetching survey responses from Qualtrics: ${QUALTRICS_SURVEY_ID}`);
            
            const response = await fetch(qualtricsUrl, {
                headers: {
                    'X-API-TOKEN': QUALTRICS_API_TOKEN,
                    'Content-Type': 'application/json'
                }
            });

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

            // Fetch survey metadata
            const qualtricsUrl = `https://${QUALTRICS_DATA_CENTER}.qualtrics.com/API/v3/surveys/${QUALTRICS_SURVEY_ID}`;
            
            const response = await fetch(qualtricsUrl, {
                headers: {
                    'X-API-TOKEN': QUALTRICS_API_TOKEN,
                    'Content-Type': 'application/json'
                }
            });

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

module.exports = { app };
