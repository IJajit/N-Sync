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

let cachedPendingListId: string | null = null;

export async function getPendingListId(): Promise<string> {
  if (cachedPendingListId) return cachedPendingListId;

  const auth = getOAuth2Client();
  if (!REFRESH_TOKEN) return '@default';

  const tasksApi = google.tasks({ version: 'v1', auth });

  try {
    const res = await tasksApi.tasklists.list({ maxResults: 100 });
    const lists = res.data.items || [];

    const pendingList = lists.find(
      (l) => l.title && l.title.trim().toLowerCase() === 'pending'
    );

    if (pendingList && pendingList.id) {
      cachedPendingListId = pendingList.id;
      return pendingList.id;
    }

    // If no list named "Pending" exists, create it
    const created = await tasksApi.tasklists.insert({
      requestBody: { title: 'Pending' },
    });
    if (created.data.id) {
      cachedPendingListId = created.data.id;
      return created.data.id;
    }
  } catch (err) {
    console.error('Error finding or creating Google Tasks "Pending" list:', err);
  }

  return '@default';
}

export interface GooglePendingTaskItem {
  id: string;
  title: string;
  notes?: string;
  due?: string;
  status: 'needsAction' | 'completed';
  completed?: string;
  isDeleted?: boolean;
  updated?: string;
}

export async function fetchGooglePendingTasks(): Promise<GooglePendingTaskItem[]> {
  const auth = getOAuth2Client();
  if (!REFRESH_TOKEN) return [];

  const tasksApi = google.tasks({ version: 'v1', auth });
  const tasklistId = await getPendingListId();

  try {
    const response = await tasksApi.tasks.list({
      tasklist: tasklistId,
      showCompleted: true,
      showHidden: true,
      showDeleted: true,
      maxResults: 100,
    });

    const items: GooglePendingTaskItem[] = [];
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

    return items;
  } catch (error) {
    console.error(`Error fetching tasks from Google Tasks "Pending" list (${tasklistId}):`, error);
    return [];
  }
}

export async function createGooglePendingTask(
  title: string,
  notes?: string,
  isCompleted: boolean = false
): Promise<string | null> {
  const auth = getOAuth2Client();
  if (!REFRESH_TOKEN) return null;

  const tasksApi = google.tasks({ version: 'v1', auth });
  const tasklistId = await getPendingListId();

  try {
    const requestBody: any = {
      title,
      notes: notes || undefined,
      status: isCompleted ? 'completed' : 'needsAction',
    };

    const res = await tasksApi.tasks.insert({
      tasklist: tasklistId,
      requestBody,
    });

    return res.data.id || null;
  } catch (error) {
    console.error(`Error creating task on Google Tasks "Pending" list (${tasklistId}):`, error);
    return null;
  }
}

export async function updateGooglePendingTask(
  taskId: string,
  updates: { title?: string; notes?: string; isCompleted?: boolean }
): Promise<boolean> {
  const auth = getOAuth2Client();
  if (!REFRESH_TOKEN || !taskId) return false;

  const tasksApi = google.tasks({ version: 'v1', auth });
  const tasklistId = await getPendingListId();

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

    await tasksApi.tasks.patch({
      tasklist: tasklistId,
      task: taskId,
      requestBody,
    });

    return true;
  } catch (error) {
    console.error(`Error updating Google Pending Task ${taskId}:`, error);
    return false;
  }
}

export async function deleteGooglePendingTask(taskId: string): Promise<boolean> {
  const auth = getOAuth2Client();
  if (!REFRESH_TOKEN || !taskId) return false;

  const tasksApi = google.tasks({ version: 'v1', auth });
  const tasklistId = await getPendingListId();

  try {
    await tasksApi.tasks.delete({
      tasklist: tasklistId,
      task: taskId,
    });
    return true;
  } catch (error) {
    console.error(`Error deleting Google Pending Task ${taskId}:`, error);
    return false;
  }
}
