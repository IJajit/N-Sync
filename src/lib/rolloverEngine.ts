import {
  fetchNotionTasks,
  updateNotionTask,
  NotionTaskItem,
} from './notion';
import {
  fetchGoogleCalendarEvents,
  updateGoogleCalendarEvent,
  fetchGoogleTasks,
  updateGoogleTask,
} from './google';
import { getMappings, upsertMapping, findMappingByNotionId, findMappingByTitle } from './syncStore';

export interface RolloverLog {
  timestamp: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
}

function getTodayLocalDateString(): string {
  // Use Europe/Rome timezone (or system local date) in YYYY-MM-DD format
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date());
}

/**
 * Automatically checks for uncompleted tasks with past due dates (< today)
 * and moves them to today across Notion, Google Calendar, and Google Tasks.
 */
export async function runMidnightRollover(): Promise<RolloverLog[]> {
  const logs: RolloverLog[] = [];
  const addLog = (message: string, type: RolloverLog['type'] = 'info') => {
    logs.push({
      timestamp: new Date().toISOString(),
      message,
      type,
    });
  };

  try {
    const todayStr = getTodayLocalDateString();

    const [allNotionTasks, gcalEvents, gtaskItems] = await Promise.all([
      fetchNotionTasks(),
      fetchGoogleCalendarEvents(),
      fetchGoogleTasks(),
    ]);

    const activeGCalEvents = gcalEvents.filter((e) => !e.isCancelled);
    const activeGTasks = gtaskItems.filter((t) => !t.isDeleted);

    // Identify active uncompleted Notion tasks whose due date is strictly in the past (< todayStr)
    const overdueNotionTasks = allNotionTasks.filter((t) => {
      if (t.isCompleted || !t.dueDate) return false;
      const taskDueDate = t.dueDate.includes('T') ? t.dueDate.split('T')[0] : t.dueDate;
      return taskDueDate < todayStr;
    });

    if (overdueNotionTasks.length === 0) {
      return logs;
    }

    addLog(`Found ${overdueNotionTasks.length} uncompleted task(s) past midnight. Rolling over to ${todayStr}...`, 'info');

    for (const task of overdueNotionTasks) {
      const cleanTitleKey = task.title.trim().toLowerCase().replace(/\s+/g, ' ');
      const mapping = findMappingByNotionId(task.id) || findMappingByTitle(task.title);

      // 1. Move in Notion
      const notionUpdated = await updateNotionTask(task.id, { dueDate: todayStr });
      if (notionUpdated) {
        addLog(`Moved Notion task "${task.title}" to ${todayStr}`, 'success');
      }

      // 2. Move in Google Calendar
      const targetGCal = (mapping?.gcalId ? activeGCalEvents.find((e) => e.id === mapping.gcalId) : undefined)
        || activeGCalEvents.find((e) => e.summary.trim().toLowerCase().replace(/\s+/g, ' ') === cleanTitleKey);

      if (targetGCal) {
        await updateGoogleCalendarEvent(targetGCal.id, { dueDate: todayStr });
        addLog(`Moved Google Calendar event "${task.title}" to ${todayStr}`, 'success');
      }

      // 3. Move in Google Tasks ("To Do" list)
      const targetGTask = (mapping?.gtaskId ? activeGTasks.find((t) => t.id === mapping.gtaskId) : undefined)
        || activeGTasks.find((t) => t.title.trim().toLowerCase().replace(/\s+/g, ' ') === cleanTitleKey);

      if (targetGTask) {
        await updateGoogleTask(targetGTask.id, { dueDate: todayStr });
        addLog(`Moved Google Task "${task.title}" to ${todayStr}`, 'success');
      }

      // 4. Update Mapping in sync_data.json
      if (mapping) {
        mapping.dueDate = todayStr;
        mapping.lastUpdated = new Date().toISOString();
        upsertMapping(mapping);
      }
    }
  } catch (error: any) {
    addLog(`Error during midnight rollover: ${error?.message || error}`, 'error');
  }

  return logs;
}
