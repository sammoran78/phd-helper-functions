const { app } = require('@azure/functions');
const { getCalendarClient } = require('../../shared/googleAuth');

// GET /api/calendar - Get calendar events
app.http('GetCalendarEvents', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'calendar',
    handler: async (request, context) => {
        try {
            const calendarId = process.env.GOOGLE_CALENDAR_ID;
            if (!calendarId) {
                return {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'GOOGLE_CALENDAR_ID not configured' })
                };
            }

            const calendar = await getCalendarClient();
            
            // Get events from 1 year ago to capture historical data
            const now = new Date();
            const oneYearAgo = new Date(now.getFullYear() - 1, now.getMonth(), 1);
            
            context.log(`Fetching calendar events from ${oneYearAgo.toISOString()}`);
            
            const response = await calendar.events.list({
                calendarId: calendarId,
                timeMin: oneYearAgo.toISOString(),
                maxResults: 500,
                singleEvents: true,
                orderBy: 'startTime',
            });
            
            const events = response.data.items.map(event => {
                const start = event.start;
                const end = event.end;
                
                return {
                    id: event.id,
                    title: event.summary || 'Untitled',
                    description: event.description || '',
                    location: event.location || '',
                    start: start.dateTime || start.date,
                    end: end.dateTime || end.date,
                    isAllDay: !start.dateTime,
                    color: event.colorId || null,
                    htmlLink: event.htmlLink
                };
            });
            
            context.log(`Found ${events.length} calendar events`);
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(events)
            };
        } catch (error) {
            context.error('Get Calendar Events Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to fetch calendar events', details: error.message })
            };
        }
    }
});

// POST /api/calendar - Create a calendar event
app.http('CreateCalendarEvent', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'calendar',
    handler: async (request, context) => {
        try {
            const calendarId = process.env.GOOGLE_CALENDAR_ID;
            if (!calendarId) {
                return {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'GOOGLE_CALENDAR_ID not configured' })
                };
            }

            const body = await request.json();
            const { title, date, isAllDay, startTime, endTime, description } = body;
            
            if (!title || !date) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'title and date are required' })
                };
            }

            const calendar = await getCalendarClient();
            
            let resource = {
                summary: title,
                description: description || '',
            };
            
            if (isAllDay) {
                resource.start = { date: date };
                resource.end = { date: date };
            } else {
                resource.start = { dateTime: `${date}T${startTime || '09:00'}:00`, timeZone: 'Australia/Sydney' };
                resource.end = { dateTime: `${date}T${endTime || '10:00'}:00`, timeZone: 'Australia/Sydney' };
            }
            
            context.log(`Creating calendar event: ${title} on ${date}`);
            
            const response = await calendar.events.insert({
                calendarId: calendarId,
                resource: resource,
            });
            
            context.log(`Created event: ${response.data.id}`);
            
            return {
                status: 201,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    success: true,
                    event: {
                        id: response.data.id,
                        title: response.data.summary,
                        htmlLink: response.data.htmlLink
                    }
                })
            };
        } catch (error) {
            context.error('Create Calendar Event Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to create calendar event', details: error.message })
            };
        }
    }
});

// DELETE /api/calendar/{id} - Delete a calendar event
app.http('DeleteCalendarEvent', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'calendar/{id}',
    handler: async (request, context) => {
        try {
            const calendarId = process.env.GOOGLE_CALENDAR_ID;
            if (!calendarId) {
                return {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'GOOGLE_CALENDAR_ID not configured' })
                };
            }

            const eventId = request.params.id;
            if (!eventId) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Event ID is required' })
                };
            }

            const calendar = await getCalendarClient();
            
            await calendar.events.delete({
                calendarId: calendarId,
                eventId: eventId,
            });
            
            context.log(`Deleted calendar event: ${eventId}`);
            
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true, message: 'Event deleted' })
            };
        } catch (error) {
            context.error('Delete Calendar Event Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Failed to delete calendar event', details: error.message })
            };
        }
    }
});
