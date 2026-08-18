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

  // Check for checkbox / status completion
  let isCompleted = false;
  if (page.properties) {
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

  return {
    id: page.id,
    title,
    isCompleted,
    dueDate,
    lastEditedTime: page.last_edited_time,
    notes,
    url,
  };
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
    const properties: any = {
      Name: {
        title: [
          {
            text: { content: title },
          },
        ],
      },
      '': {
        checkbox: isCompleted,
      },
    };

    if (dueDate) {
      properties.Deadline = {
        date: { start: dueDate },
      };
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
  updates: { title?: string; dueDate?: string; isCompleted?: boolean }
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
      for (const key of Object.keys(page.properties)) {
        const prop = page.properties[key];
        if (prop?.type === 'checkbox') {
          properties[key] = { checkbox: updates.isCompleted };
        } else if (prop?.type === 'status') {
          // Select 'Done' or option containing 'done'
          const options = prop.status?.options || [];
          const doneOpt = options.find((opt: any) => opt.name.toLowerCase().includes('done') || opt.name.toLowerCase().includes('complete'));
          properties[key] = {
            status: { name: doneOpt ? doneOpt.name : (updates.isCompleted ? 'Done' : 'Not started') },
          };
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
