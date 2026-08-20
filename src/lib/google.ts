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

let cachedNotionCalId: string | null = null;

export async function getNotionCalendarId(): Promise<string> {
  if (cachedNotionCalId) return cachedNotionCalId;

  const auth = getOAuth2Client();
  if (!REFRESH_TOKEN) return 'primary';

  const calendar = google.calendar({ version: 'v3', auth });

  try {
    const res = await calendar.calendarList.list();
    const calendars = res.data.items || [];
    const notionCal = calendars.find(
      (c) => c.summary && c.summary.trim().toLowerCase() === 'notion'
    );

    if (notionCal && notionCal.id) {
      cachedNotionCalId = notionCal.id;
      return notionCal.id;
    }

    // Create secondary "Notion" calendar if it doesn't exist
    const newCal = await calendar.calendars.insert({
      requestBody: {
        summary: 'Notion',
        timeZone: 'Asia/Kolkata',
      },
    });

    if (newCal.data.id) {
      cachedNotionCalId = newCal.data.id;
      return newCal.data.id;
    }
  } catch (err) {
    console.error('Error finding/creating Notion secondary calendar:', err);
  }

  return 'primary';
}

export interface GCalEventItem {
  id: string;
  summary: string;
  description?: string;
  start?: string;
  updated?: string;
  isCancelled?: boolean;
}

export async function fetchGoogleCalendarEvents(): Promise<GCalEventItem[]> {
  const auth = getOAuth2Client();
  if (!REFRESH_TOKEN) return [];

  const calendar = google.calendar({ version: 'v3', auth });
  const calId = await getNotionCalendarId();

  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const timeMin = todayStart.toISOString();
    const timeMax = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000).toISOString();

    const response = await calendar.events.list({
      calendarId: calId,
      singleEvents: true,
      showDeleted: true,
      orderBy: 'startTime',
      timeMin,
      timeMax,
    });

    const items: GCalEventItem[] = [];
    for (const evt of response.data.items || []) {
      if (!evt.id) continue;
      const isCancelled = evt.status === 'cancelled';
      let startDate: string | undefined = undefined;
      if (evt.start?.date) {
        startDate = evt.start.date;
      } else if (evt.start?.dateTime) {
        startDate = evt.start.dateTime;
      }

      items.push({
        id: evt.id,
        summary: evt.summary || 'Untitled Event',
        description: evt.description || '',
        start: startDate,
        updated: evt.updated || undefined,
        isCancelled,
      });
    }

    return items;
  } catch (error) {
    console.error(`Error fetching Google Calendar events from calendar ${calId}:`, error);
    return [];
  }
}

function getExclusiveEndDate(dateStr: string): string {
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    const yyyy = parseInt(parts[0], 10);
    const mm = parseInt(parts[1], 10) - 1;
    const dd = parseInt(parts[2], 10);
    const nextDay = new Date(Date.UTC(yyyy, mm, dd + 1));
    return nextDay.toISOString().split('T')[0];
  }
  return dateStr;
}

export async function createGoogleCalendarEvent(title: string, dueDate?: string, description?: string): Promise<string | null> {
  const auth = getOAuth2Client();
  if (!REFRESH_TOKEN) return null;

  const calendar = google.calendar({ version: 'v3', auth });
  const calId = await getNotionCalendarId();

  try {
    const requestBody: any = {
      summary: title,
      description: description || undefined,
    };

    if (dueDate) {
      if (dueDate.includes('T') && !dueDate.endsWith('T00:00:00.000Z')) {
        const startDate = new Date(dueDate);
        const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
        requestBody.start = { dateTime: startDate.toISOString() };
        requestBody.end = { dateTime: endDate.toISOString() };
      } else {
        const dateOnly = dueDate.split('T')[0];
        requestBody.start = { date: dateOnly };
        requestBody.end = { date: getExclusiveEndDate(dateOnly) };
      }
    } else {
      const todayStr = new Date().toISOString().split('T')[0];
      requestBody.start = { date: todayStr };
      requestBody.end = { date: getExclusiveEndDate(todayStr) };
    }

    const res = await calendar.events.insert({
      calendarId: calId,
      requestBody,
    });

    return res.data.id || null;
  } catch (error) {
    console.error(`Error creating Google Calendar event on calendar ${calId}:`, error);
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
  const calId = await getNotionCalendarId();

  try {
    const requestBody: any = {};

    if (updates.title !== undefined) {
      requestBody.summary = updates.title;
    }

    if (updates.description !== undefined) {
      requestBody.description = updates.description;
    }

    if (updates.dueDate !== undefined) {
      if (updates.dueDate && updates.dueDate.includes('T')) {
        const startDate = new Date(updates.dueDate);
        const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
        requestBody.start = { dateTime: startDate.toISOString() };
        requestBody.end = { dateTime: endDate.toISOString() };
      } else if (updates.dueDate) {
        requestBody.start = { date: updates.dueDate };
        requestBody.end = { date: getExclusiveEndDate(updates.dueDate) };
      }
    }

    await calendar.events.patch({
      calendarId: calId,
      eventId,
      requestBody,
    });
    return true;
  } catch (error) {
    console.error(`Error updating Google Calendar event ${eventId} on calendar ${calId}:`, error);
    return false;
  }
}

export async function deleteGoogleCalendarEvent(eventId: string): Promise<boolean> {
  const auth = getOAuth2Client();
  if (!REFRESH_TOKEN || !eventId) return false;

  const calendar = google.calendar({ version: 'v3', auth });
  const calId = await getNotionCalendarId();

  try {
    await calendar.events.delete({
      calendarId: calId,
      eventId,
    });
    return true;
  } catch (error) {
    console.error(`Error deleting Google Calendar event ${eventId} on calendar ${calId}:`, error);
    return false;
  }
}

// =============================================================================
// GOOGLE TASKS API INTEGRATION ("To Do List")
// =============================================================================

let cachedToDoListId: string | null = null;

export async function getToDoListId(): Promise<string> {
  if (cachedToDoListId) return cachedToDoListId;

  const auth = getOAuth2Client();
  if (!REFRESH_TOKEN) return '@default';

  const tasksApi = google.tasks({ version: 'v1', auth });

  try {
    const res = await tasksApi.tasklists.list({ maxResults: 100 });
    const lists = res.data.items || [];

    // Search for existing list named "To Do List" or "To Do"
    const toDoList = lists.find(
      (l) => l.title && (l.title.trim().toLowerCase() === 'to do list' || l.title.trim().toLowerCase() === 'todo list' || l.title.trim().toLowerCase() === 'to do')
    );

    if (toDoList && toDoList.id) {
      cachedToDoListId = toDoList.id;
      return toDoList.id;
    }

    // Create "To Do List" if it doesn't exist
    const newList = await tasksApi.tasklists.insert({
      requestBody: {
        title: 'To Do List',
      },
    });

    if (newList.data.id) {
      cachedToDoListId = newList.data.id;
      return newList.data.id;
    }
  } catch (err) {
    console.error('Error finding or creating Google Tasks "To Do List":', err);
  }

  return '@default';
}

export interface GTaskItem {
  id: string;
  title: string;
  notes?: string;
  due?: string;
  status: 'needsAction' | 'completed';
  completed?: string;
  isDeleted?: boolean;
  updated?: string;
}

export async function fetchGoogleTasks(): Promise<GTaskItem[]> {
  const auth = getOAuth2Client();
  if (!REFRESH_TOKEN) return [];

  const tasksApi = google.tasks({ version: 'v1', auth });

  try {
    const tasklistsRes = await tasksApi.tasklists.list({ maxResults: 100 });
    const lists = tasklistsRes.data.items || [];

    const items: GTaskItem[] = [];

    for (const list of lists) {
      if (!list.id) continue;
      try {
        const response = await tasksApi.tasks.list({
          tasklist: list.id,
          showCompleted: true,
          showHidden: true,
          showDeleted: true,
          maxResults: 100,
        });

        for (const item of response.data.items || []) {
          if (!item.id || !item.title) continue;
          items.push({
            id: item.id,
            title: item.title,
            notes: item.notes || undefined,
            due: item.due || undefined,
            status: (item.status as 'needsAction' | 'completed') || 'needsAction',
            completed: item.completed || undefined,
            isDeleted: Boolean(item.deleted),
            updated: item.updated || undefined,
          });
        }
      } catch (e) {
        // Continue scanning other tasklists
      }
    }

    return items;
  } catch (error) {
    console.error(`Error fetching Google Tasks across task lists:`, error);
    return [];
  }
}

export async function createGoogleTask(title: string, dueDate?: string, notes?: string, isCompleted: boolean = false): Promise<string | null> {
  const auth = getOAuth2Client();
  if (!REFRESH_TOKEN) return null;

  const tasksApi = google.tasks({ version: 'v1', auth });
  const tasklistId = await getToDoListId();

  try {
    const requestBody: any = {
      title,
      notes: notes || undefined,
      status: isCompleted ? 'completed' : 'needsAction',
    };

    if (dueDate) {
      // RFC 3339 format required by Google Tasks
      requestBody.due = new Date(dueDate).toISOString();
    }

    const res = await tasksApi.tasks.insert({
      tasklist: tasklistId,
      requestBody,
    });

    return res.data.id || null;
  } catch (error) {
    console.error(`Error creating Google Task on list ${tasklistId}:`, error);
    return null;
  }
}

export async function updateGoogleTask(
  taskId: string,
  updates: { title?: string; dueDate?: string; notes?: string; isCompleted?: boolean }
): Promise<boolean> {
  const auth = getOAuth2Client();
  if (!REFRESH_TOKEN || !taskId) return false;

  const tasksApi = google.tasks({ version: 'v1', auth });
  const tasklistId = await getToDoListId();

  try {
    const requestBody: any = {};

    if (updates.title !== undefined) {
      requestBody.title = updates.title;
    }
    if (updates.notes !== undefined) {
      requestBody.notes = updates.notes;
    }
    if (updates.isCompleted !== undefined) {
      requestBody.status = updates.isCompleted ? 'completed' : 'needsAction';
    }
    if (updates.dueDate !== undefined) {
      requestBody.due = updates.dueDate ? new Date(updates.dueDate).toISOString() : null;
    }

    await tasksApi.tasks.patch({
      tasklist: tasklistId,
      task: taskId,
      requestBody,
    });

    return true;
  } catch (error) {
    console.error(`Error updating Google Task ${taskId} on list ${tasklistId}:`, error);
    return false;
  }
}

export async function deleteGoogleTask(taskId: string): Promise<boolean> {
  const auth = getOAuth2Client();
  if (!REFRESH_TOKEN || !taskId) return false;

  const tasksApi = google.tasks({ version: 'v1', auth });
  const tasklistId = await getToDoListId();

  try {
    await tasksApi.tasks.delete({
      tasklist: tasklistId,
      task: taskId,
    });
    return true;
  } catch (error) {
    console.error(`Error deleting Google Task ${taskId} on list ${tasklistId}:`, error);
    return false;
  }
}

