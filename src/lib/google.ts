import { google } from 'googleapis';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/api/auth/google/callback';
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN || '';

export function getOAuth2Client() {
  const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  if (REFRESH_TOKEN) {
    oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
  }
  return oAuth2Client;
}

// ==================== GOOGLE CALENDAR ====================

export interface GCalEventItem {
  id: string;
  summary: string;
  description?: string;
  start?: string;
  updated?: string;
}

async function getNotionCalendarId(calendar: any): Promise<string> {
  try {
    const listRes = await calendar.calendarList.list();
    const existing = (listRes.data.items || []).find(
      (c: any) => c.summary && c.summary.trim().toLowerCase() === 'notion'
    );

    if (existing && existing.id) {
      return existing.id;
    }

    const created = await calendar.calendars.insert({
      requestBody: { summary: 'Notion' },
    });
    return created.data.id || 'primary';
  } catch (error) {
    console.error('Error finding/creating Notion calendar, falling back to primary:', error);
    return 'primary';
  }
}

export async function fetchGoogleCalendarEvents(): Promise<GCalEventItem[]> {
  const auth = getOAuth2Client();
  if (!REFRESH_TOKEN) return [];

  const calendar = google.calendar({ version: 'v3', auth });

  try {
    const calId = await getNotionCalendarId(calendar);
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const timeMin = todayStart.toISOString(); // From start of today
    const timeMax = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000).toISOString(); // Next 180 days

    // Query both secondary 'Notion' calendar and primary calendar
    const calendarIdsToQuery = new Set([calId, 'primary']);
    const allEventsMap = new Map<string, GCalEventItem>();

    for (const targetCalId of calendarIdsToQuery) {
      try {
        const response = await calendar.events.list({
          calendarId: targetCalId,
          singleEvents: true,
          orderBy: 'startTime',
          timeMin,
          timeMax,
        });

        for (const evt of response.data.items || []) {
          if (evt.id && !allEventsMap.has(evt.id)) {
            // Standardize start date format
            let startDate: string | undefined = undefined;
            if (evt.start?.date) {
              startDate = evt.start.date;
            } else if (evt.start?.dateTime) {
              startDate = evt.start.dateTime.split('T')[0];
            }

            allEventsMap.set(evt.id, {
              id: evt.id,
              summary: evt.summary || 'Untitled Event',
              description: evt.description || '',
              start: startDate,
              updated: evt.updated || undefined,
            });
          }
        }
      } catch (err) {
        console.warn(`Could not list events for calendar ${targetCalId}:`, err);
      }
    }

    const eventsList = Array.from(allEventsMap.values());
    console.log(`[Google Calendar] Fetched ${eventsList.length} events across primary & secondary calendars.`);
    return eventsList;
  } catch (error) {
    console.error('Error fetching Google Calendar events:', error);
    return [];
  }
}

export async function createGoogleCalendarEvent(title: string, dueDate?: string, description?: string): Promise<string | null> {
  const auth = getOAuth2Client();
  if (!REFRESH_TOKEN) return null;

  const calendar = google.calendar({ version: 'v3', auth });

  try {
    const calId = await getNotionCalendarId(calendar);
    const targetDate = dueDate ? new Date(dueDate) : new Date();
    const dateString = targetDate.toISOString().split('T')[0];

    const res = await calendar.events.insert({
      calendarId: calId,
      requestBody: {
        summary: title,
        description: description || undefined,
        start: { date: dateString },
        end: { date: dateString },
      },
    });

    return res.data.id || null;
  } catch (error) {
    console.error('Error creating Google Calendar event:', error);
    return null;
  }
}

export async function updateGoogleCalendarEvent(
  eventId: string,
  updates: { title?: string; dueDate?: string; description?: string }
): Promise<boolean> {
  const auth = getOAuth2Client();
  if (!REFRESH_TOKEN || !eventId) return false;

  const calendar = google.calendar({ version: 'v3', auth });

  try {
    const calId = await getNotionCalendarId(calendar);
    const requestBody: any = {};

    if (updates.title !== undefined) {
      requestBody.summary = updates.title;
    }

    if (updates.description !== undefined) {
      requestBody.description = updates.description;
    }

    if (updates.dueDate !== undefined) {
      const targetDate = updates.dueDate ? new Date(updates.dueDate) : new Date();
      const dateString = targetDate.toISOString().split('T')[0];
      requestBody.start = { date: dateString };
      requestBody.end = { date: dateString };
    }

    await calendar.events.patch({
      calendarId: calId,
      eventId,
      requestBody,
    });

    return true;
  } catch (error) {
    console.error(`Error updating Google Calendar event ${eventId}:`, error);
    return false;
  }
}

export async function deleteGoogleCalendarEvent(eventId: string): Promise<boolean> {
  const auth = getOAuth2Client();
  if (!REFRESH_TOKEN || !eventId) return false;

  const calendar = google.calendar({ version: 'v3', auth });

  try {
    const calId = await getNotionCalendarId(calendar);
    await calendar.events.delete({
      calendarId: calId,
      eventId,
    });
    return true;
  } catch (error) {
    console.error(`Error deleting Google Calendar event ${eventId}:`, error);
    return false;
  }
}
