import { Client } from '@notionhq/client';

const NOTION_TOKEN = process.env.NOTION_TOKEN || '';
export const NOTION_TASKS_DB_ID = process.env.NOTION_TASKS_DB_ID || '368e6d69-8017-804e-80ff-cd271324212f';

export function getNotionClient() {
  return new Client({ auth: NOTION_TOKEN });
}

export interface NotionTaskItem {
  id: string;
  title: string;
  isCompleted: boolean;
  dueDate?: string;
  lastEditedTime: string;
  notes?: string;
  url?: string;
  notionPageUrl?: string;
}

export async function fetchNotionTasks(): Promise<NotionTaskItem[]> {
  const notion = getNotionClient();
  if (!NOTION_TOKEN) return [];

  try {
    let allResults: any[] = [];
    let hasMore = true;
    let nextCursor: string | undefined = undefined;

    while (hasMore) {
      const response: any = await notion.search({
        query: '',
        filter: {
          value: 'page',
          property: 'object',
        } as any,
        page_size: 100,
        start_cursor: nextCursor,
      });

      if (response.results) {
        allResults = allResults.concat(response.results);
      }

      hasMore = response.has_more;
      nextCursor = response.next_cursor || undefined;
    }

    const targetDbId = NOTION_TASKS_DB_ID ? NOTION_TASKS_DB_ID.replace(/-/g, '') : null;

    const parsedTasks = allResults
      .filter((page: any) => {
        if (!targetDbId) return true;
        const pageDbId = page.parent?.database_id ? page.parent.database_id.replace(/-/g, '') : null;
        return pageDbId === targetDbId;
      })
      .map((page: any) => parseNotionPage(page))
      .filter((item): item is NotionTaskItem => item !== null);

    return parsedTasks;
  } catch (error) {
    console.error('Error fetching Notion tasks:', error);
    return [];
  }
}

function parseNotionPage(page: any): NotionTaskItem | null {
  let title: string | null = null;

  if (page.properties) {
    for (const key of Object.keys(page.properties)) {
      const prop = page.properties[key];
      if (prop?.type === 'title' && Array.isArray(prop.title) && prop.title.length > 0) {
        title = prop.title.map((t: any) => t.plain_text).join('').trim();
        if (title) break;
      }
    }
  }

  if (!title && page.properties) {
    for (const key of Object.keys(page.properties)) {
      const prop = page.properties[key];
      if (prop?.type === 'rich_text' && Array.isArray(prop.rich_text) && prop.rich_text.length > 0) {
        title = prop.rich_text.map((t: any) => t.plain_text).join('').trim();
        if (title) break;
      }
    }
  }

  if (!title) return null;

  // Check for checkbox / status completion (prefer 'check' property name if present)
  let isCompleted = false;
  if (page.properties) {
    // First look for exact property named 'check' or 'Check'
    for (const key of Object.keys(page.properties)) {
      if (key.toLowerCase() === 'check') {
        const prop = page.properties[key];
        if (prop?.type === 'checkbox') {
          isCompleted = Boolean(prop.checkbox);
          break;
        } else if (prop?.type === 'status') {
          const statusName = prop.status?.name?.toLowerCase() || '';
          if (statusName === 'done' || statusName === 'completed' || statusName.includes('done')) {
            isCompleted = true;
          }
          break;
        }
      }
    }

    // Fallback to any checkbox or status property if 'check' was not found
    if (!isCompleted) {
      for (const key of Object.keys(page.properties)) {
        const prop = page.properties[key];
        if (prop?.type === 'checkbox') {
          if (Boolean(prop.checkbox)) {
            isCompleted = true;
            break;
          }
        } else if (prop?.type === 'status') {
          const statusName = prop.status?.name?.toLowerCase() || '';
          if (statusName === 'done' || statusName === 'completed' || statusName.includes('done')) {
            isCompleted = true;
            break;
          }
        }
      }
    }
  }

  // Priority 1: Explicit Date property
  let dueDate: string | undefined = undefined;
  if (page.properties) {
    for (const key of Object.keys(page.properties)) {
      const prop = page.properties[key];
      if (prop?.type === 'date' && prop.date?.start) {
        dueDate = prop.date.start;
        break;
      } else if (prop?.type === 'formula' && prop.formula?.date?.start) {
        dueDate = prop.formula.date.start;
        break;
      }
    }
  }

  // Priority 2: Default to today's date so active tasks are synced to calendar
  if (!dueDate) {
    dueDate = new Date().toISOString().split('T')[0];
  }

  // Extract Notes / Text properties
  let notes: string | undefined = undefined;
  if (page.properties) {
    for (const key of Object.keys(page.properties)) {
      const prop = page.properties[key];
      if (key.toLowerCase().includes('note') || key.toLowerCase().includes('description') || key.toLowerCase().includes('comment')) {
        if (prop?.type === 'rich_text' && Array.isArray(prop.rich_text)) {
          notes = prop.rich_text.map((t: any) => t.plain_text).join('\n');
          break;
        }
      }
    }
  }

  // Extract URL property
  let url: string | undefined = undefined;
  if (page.properties) {
    for (const key of Object.keys(page.properties)) {
      const prop = page.properties[key];
      if (prop?.type === 'url' && prop.url) {
        url = prop.url;
        break;
      }
    }
  }

  const notionPageUrl = page.url || `https://www.notion.so/${page.id.replace(/-/g, '')}`;

  return {
    id: page.id,
    title,
    isCompleted,
    dueDate,
    lastEditedTime: page.last_edited_time,
    notes,
    url,
    notionPageUrl,
  };
}

export function cleanGCalDescription(rawDesc?: string): string {
  if (!rawDesc) return '';

  let text = rawDesc;

  // Replace HTML linebreaks
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p>/gi, '\n');
  text = text.replace(/<p>/gi, '');

  // Replace anchor links
  text = text.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, (_, href, content) => {
    const cleanContent = content.replace(/<[^>]+>/g, '').trim();
    if (!cleanContent || cleanContent === href) {
      return href;
    }
    return `${cleanContent} (${href})`;
  });

  // Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Unescape HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  // Remove auto-generated "Notion Task: https://app.notion.com/..." lines from notes
  text = text
    .split('\n')
    .filter((line) => !line.trim().startsWith('Notion Task: https://app.notion.com/'))
    .join('\n')
    .trim();

  return text;
}

export async function createNotionTask(
  title: string,
  dueDate?: string,
  isCompleted: boolean = false,
  notes?: string
): Promise<string | null> {
  const notion = getNotionClient();
  if (!NOTION_TOKEN) return null;

  try {
    // Dynamically retrieve database schema to map properties correctly
    let titlePropKey = 'Name';
    let checkPropKey: string | undefined = undefined;
    let datePropKey: string | undefined = undefined;
    let notesPropKey: string | undefined = undefined;

    try {
      const db: any = await notion.databases.retrieve({ database_id: NOTION_TASKS_DB_ID });
      if (db.properties) {
        for (const key of Object.keys(db.properties)) {
          const prop = db.properties[key];
          if (prop?.type === 'title') {
            titlePropKey = key;
          } else if (key.toLowerCase() === 'check') {
            checkPropKey = key;
          } else if (prop?.type === 'checkbox' && !checkPropKey) {
            checkPropKey = key;
          } else if (prop?.type === 'date' && !datePropKey) {
            datePropKey = key;
          } else if ((key.toLowerCase().includes('note') || key.toLowerCase().includes('desc')) && prop?.type === 'rich_text') {
            notesPropKey = key;
          }
        }
      }
    } catch (e) {
      console.warn('Could not retrieve DB schema dynamically, using standard defaults:', e);
    }

    const properties: any = {
      [titlePropKey]: {
        title: [
          {
            text: { content: title },
          },
        ],
      },
    };

    if (checkPropKey) {
      properties[checkPropKey] = { checkbox: isCompleted };
    } else {
      properties['check'] = { checkbox: isCompleted };
    }

    if (dueDate) {
      const key = datePropKey || 'Deadline';
      const cleanDate = dueDate.includes('T') ? dueDate.split('T')[0] : dueDate;
      properties[key] = {
        date: { start: cleanDate },
      };
    }

    if (notes) {
      const cleanedNotes = cleanGCalDescription(notes);
      if (cleanedNotes) {
        const key = notesPropKey || 'Notes';
        const content = cleanedNotes.substring(0, 2000);
        properties[key] = {
          rich_text: [
            {
              text: { content },
            },
          ],
        };
      }
    }

    const response = await notion.pages.create({
      parent: { database_id: NOTION_TASKS_DB_ID },
      properties,
    });

    return response.id;
  } catch (error) {
    console.error('Error creating Notion task:', error);
    return null;
  }
}

export async function verifyNotionPageArchived(pageId: string): Promise<boolean> {
  const notion = getNotionClient();
  if (!NOTION_TOKEN) return false;

  try {
    const page: any = await notion.pages.retrieve({ page_id: pageId });
    return Boolean(page.archived);
  } catch (error: any) {
    // 404 error means page was permanently deleted / trashed
    if (error?.status === 404 || error?.code === 'object_not_found') {
      return true;
    }
    return false;
  }
}

export async function deleteNotionTaskPage(pageId: string): Promise<boolean> {
  const notion = getNotionClient();
  if (!NOTION_TOKEN) return false;

  try {
    // Archive / delete page in Notion database
    await notion.pages.update({
      page_id: pageId,
      archived: true,
    });
    return true;
  } catch (error) {
    console.error(`Error archiving Notion page ${pageId}:`, error);
    return false;
  }
}

export async function updateNotionTask(
  pageId: string,
  updates: { title?: string; dueDate?: string; isCompleted?: boolean; notes?: string }
): Promise<boolean> {
  const notion = getNotionClient();
  if (!NOTION_TOKEN) return false;

  try {
    const page: any = await notion.pages.retrieve({ page_id: pageId });
    const properties: any = {};

    if (updates.title !== undefined && page.properties) {
      for (const key of Object.keys(page.properties)) {
        const prop = page.properties[key];
        if (prop?.type === 'title') {
          properties[key] = {
            title: [{ text: { content: updates.title } }],
          };
          break;
        }
      }
    }

    if (updates.isCompleted !== undefined && page.properties) {
      // Look for explicit property named 'check' or 'Check' first
      let checkPropKey: string | undefined = Object.keys(page.properties).find((k) => k.toLowerCase() === 'check');

      if (checkPropKey) {
        const prop = page.properties[checkPropKey];
        if (prop?.type === 'checkbox') {
          properties[checkPropKey] = { checkbox: updates.isCompleted };
        } else if (prop?.type === 'status') {
          const options = prop.status?.options || [];
          const doneOpt = options.find((opt: any) => opt.name.toLowerCase().includes('done') || opt.name.toLowerCase().includes('complete'));
          properties[checkPropKey] = {
            status: { name: updates.isCompleted ? (doneOpt ? doneOpt.name : 'Done') : 'Not started' },
          };
        }
      } else {
        // Fallback to any checkbox or status property
        for (const key of Object.keys(page.properties)) {
          const prop = page.properties[key];
          if (prop?.type === 'checkbox') {
            properties[key] = { checkbox: updates.isCompleted };
          } else if (prop?.type === 'status') {
            const options = prop.status?.options || [];
            const doneOpt = options.find((opt: any) => opt.name.toLowerCase().includes('done') || opt.name.toLowerCase().includes('complete'));
            properties[key] = {
              status: { name: doneOpt ? doneOpt.name : (updates.isCompleted ? 'Done' : 'Not started') },
            };
          }
        }
      }
    }

    if (updates.dueDate !== undefined && page.properties) {
      for (const key of Object.keys(page.properties)) {
        const prop = page.properties[key];
        if (prop?.type === 'date') {
          properties[key] = updates.dueDate ? { date: { start: updates.dueDate } } : { date: null };
          break;
        }
      }
    }

    if (updates.notes !== undefined && page.properties) {
      const cleanedNotes = cleanGCalDescription(updates.notes);

      let notesKey: string | undefined = undefined;
      let websiteKey: string | undefined = undefined;

      for (const key of Object.keys(page.properties)) {
        const prop = page.properties[key];
        const lowerKey = key.toLowerCase();
        if (lowerKey.includes('note') || lowerKey.includes('description') || lowerKey.includes('comment')) {
          if (prop?.type === 'rich_text') {
            notesKey = key;
          }
        }
        if (prop?.type === 'url') {
          websiteKey = key;
        }
      }
      if (!notesKey && page.properties['Notes']?.type === 'rich_text') {
        notesKey = 'Notes';
      }

      if (notesKey) {
        const content = cleanedNotes.substring(0, 2000);
        properties[notesKey] = {
          rich_text: content ? [{ text: { content } }] : [],
        };
      }

      if (websiteKey && cleanedNotes) {
        const urlMatch = cleanedNotes.match(/https?:\/\/[^\s]+/i);
        if (urlMatch) {
          properties[websiteKey] = { url: urlMatch[0] };
        }
      }
    }

    await notion.pages.update({
      page_id: pageId,
      properties,
    });

    return true;
  } catch (error) {
    console.error(`Error updating Notion task ${pageId}:`, error);
    return false;
  }
}
