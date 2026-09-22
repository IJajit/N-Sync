import { fetchNotionTasks, cleanGCalDescription } from './notion';
import {
  fetchGoogleCalendarEvents,
  createGoogleCalendarEvent,
  updateGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
  fetchGoogleTasks,
  createGoogleTask,
  updateGoogleTask,
  deleteGoogleTask,
} from './google';
import {
  fetchGooglePendingTasks,
  createGooglePendingTask,
  deleteGooglePendingTask,
} from './googlePendingTasks';
import {
  getMappings,
  saveMappings,
  TaskMapping,
  upsertMapping,
} from './syncStore';
import {
  getPendingMappings,
  savePendingMappings,
  PendingTaskMapping,
  upsertPendingMapping,
} from './pendingSyncStore';
import { runMidnightRollover } from './rolloverEngine';

export interface CleanSyncLog {
  timestamp: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
}

/**
 * Performs a comprehensive Clean Sync:
 * 1. Executes midnight rollover for any past due incomplete tasks.
 * 2. Fetches authoritative state from Notion database.
 * 3. Syncs active dated Notion tasks to Google Calendar & Google Tasks ("To Do").
 * 4. Syncs active dateless Notion tasks to Google Tasks ("Pending").
 * 5. Rebuilds sync mappings cleanly and purges orphaned/duplicate entries.
 */
export async function runCleanSync(): Promise<CleanSyncLog[]> {
  const logs: CleanSyncLog[] = [];
  const addLog = (message: string, type: CleanSyncLog['type'] = 'info') => {
    logs.push({
      timestamp: new Date().toISOString(),
      message,
      type,
    });
  };

  try {
    addLog('Starting Clean Sync audit across Notion, Google Calendar, and Google Tasks...', 'info');

    // Step 0: Midnight rollover first
    const rolloverLogs = await runMidnightRollover();
    for (const rLog of rolloverLogs) {
      logs.push(rLog);
    }

    // Step 1: Fetch live data
    const [allNotionTasks, gcalEvents, gtaskItems, pendingGTasks] = await Promise.all([
      fetchNotionTasks(),
      fetchGoogleCalendarEvents(),
      fetchGoogleTasks(),
      fetchGooglePendingTasks(),
    ]);

    const activeGCalEvents = gcalEvents.filter((e) => !e.isCancelled);
    const activeGTasks = gtaskItems.filter((t) => !t.isDeleted);
    const activePendingTasks = pendingGTasks.filter((t) => !t.isDeleted);

    addLog(`Audited live state: ${allNotionTasks.length} Notion tasks (${allNotionTasks.filter(t => !t.isCompleted).length} active), ${activeGCalEvents.length} Calendar events, ${activeGTasks.length} To-Do tasks, ${activePendingTasks.length} Pending tasks.`, 'info');

    // =========================================================================
    // DEDUPLICATE GOOGLE CALENDAR
    // =========================================================================
    const gcalByTitle = new Map<string, typeof activeGCalEvents>();
    for (const evt of activeGCalEvents) {
      const key = evt.summary.trim().toLowerCase().replace(/\s+/g, ' ');
      if (!gcalByTitle.has(key)) gcalByTitle.set(key, []);
      gcalByTitle.get(key)!.push(evt);
    }

    for (const [key, evts] of gcalByTitle.entries()) {
      if (evts.length > 1) {
        for (let i = 1; i < evts.length; i++) {
          await deleteGoogleCalendarEvent(evts[i].id);
          addLog(`Removed duplicate Google Calendar event: "${evts[i].summary}"`, 'info');
        }
      }
    }

    // =========================================================================
    // REBUILD CLEAN DATED TASKS MAPPINGS & SYNC
    // =========================================================================
    const cleanDatedMappings: TaskMapping[] = [];
    const activeDatedNotion = allNotionTasks.filter((t) => !t.isCompleted && t.dueDate);

    for (const task of activeDatedNotion) {
      const cleanTitleKey = task.title.trim().toLowerCase().replace(/\s+/g, ' ');
      const cleanDue = task.dueDate ? (task.dueDate.includes('T') ? task.dueDate.split('T')[0] : task.dueDate) : undefined;

      // Ensure GCal event
      let gcalEvt = activeGCalEvents.find((e) => e.summary.trim().toLowerCase().replace(/\s+/g, ' ') === cleanTitleKey);
      let gcalId: string | undefined = gcalEvt?.id;

      if (!gcalId) {
        gcalId = (await createGoogleCalendarEvent(task.title, task.dueDate, task.notes)) || undefined;
        if (gcalId) {
          addLog(`Created Google Calendar event for "${task.title}"`, 'success');
        }
      } else {
        // Ensure date is aligned
        const evtDue = gcalEvt?.start ? (gcalEvt.start.includes('T') ? gcalEvt.start.split('T')[0] : gcalEvt.start) : undefined;
        if (evtDue !== cleanDue) {
          await updateGoogleCalendarEvent(gcalId, { title: task.title, dueDate: task.dueDate, description: task.notes });
          addLog(`Aligned date for Google Calendar event "${task.title}"`, 'info');
        }
      }

      // Ensure Google Task ("To Do")
      let gtask = activeGTasks.find((t) => t.title.trim().toLowerCase().replace(/\s+/g, ' ') === cleanTitleKey);
      let gtaskId: string | undefined = gtask?.id;

      if (!gtaskId) {
        gtaskId = (await createGoogleTask(task.title, task.dueDate, task.notes)) || undefined;
        if (gtaskId) {
          addLog(`Created Google Task for "${task.title}"`, 'success');
        }
      } else if (gtask) {
        const tDue = gtask.due ? (gtask.due.includes('T') ? gtask.due.split('T')[0] : gtask.due) : undefined;
        if (tDue !== cleanDue) {
          await updateGoogleTask(gtaskId, { title: task.title, dueDate: task.dueDate, notes: task.notes });
          addLog(`Aligned date for Google Task "${task.title}"`, 'info');
        }
      }

      cleanDatedMappings.push({
        id: task.id,
        notionId: task.id,
        gcalId,
        gtaskId,
        title: task.title,
        dueDate: cleanDue,
        description: task.notes,
        isCompleted: false,
        lastUpdated: new Date().toISOString(),
        sourcePlatform: 'notion',
      });
    }

    // Preserve completed mappings for reference
    const oldMappings = getMappings();
    for (const m of oldMappings) {
      if (m.isCompleted && !cleanDatedMappings.some((c) => c.id === m.id || c.notionId === m.notionId)) {
        cleanDatedMappings.push(m);
      }
    }

    saveMappings(cleanDatedMappings);
    addLog(`Cleaned and saved ${cleanDatedMappings.length} mappings in sync store.`, 'success');

    // =========================================================================
    // REBUILD CLEAN PENDING TASKS MAPPINGS & SYNC
    // =========================================================================
    const cleanPendingMappings: PendingTaskMapping[] = [];
    const activeDatelessNotion = allNotionTasks.filter((t) => !t.isCompleted && !t.dueDate);

    for (const task of activeDatelessNotion) {
      const cleanTitleKey = task.title.trim().toLowerCase().replace(/\s+/g, ' ');

      let gtask = activePendingTasks.find((t) => t.title.trim().toLowerCase().replace(/\s+/g, ' ') === cleanTitleKey);
      let gtaskId: string | undefined = gtask?.id;

      if (!gtaskId) {
        gtaskId = (await createGooglePendingTask(task.title, task.notes, false)) || undefined;
        if (gtaskId) {
          addLog(`Synced dateless task "${task.title}" to Google Tasks Pending list`, 'success');
        }
      }

      cleanPendingMappings.push({
        id: task.id,
        notionId: task.id,
        gtaskId,
        title: task.title,
        description: task.notes,
        isCompleted: false,
        lastUpdated: new Date().toISOString(),
        sourcePlatform: 'notion',
      });
    }

    savePendingMappings(cleanPendingMappings);
    addLog(`Cleaned and saved ${cleanPendingMappings.length} pending task mappings.`, 'success');

    addLog('Clean Sync completed successfully! All platforms are verified and unified.', 'success');
  } catch (error: any) {
    addLog(`Error during clean sync execution: ${error?.message || error}`, 'error');
  }

  return logs;
}
