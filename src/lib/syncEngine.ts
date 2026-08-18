import { fetchNotionTasks, createNotionTask, updateNotionTask, deleteNotionTaskPage } from './notion';
import {
  fetchGoogleCalendarEvents,
  createGoogleCalendarEvent,
  updateGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
} from './google';
import {
  getMappings,
  upsertMapping,
  findMappingByNotionId,
  findMappingByGCalId,
  findMappingByTitle,
} from './syncStore';

export interface SyncLog {
  timestamp: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
}

export async function runTwoWaySync(): Promise<SyncLog[]> {
  const logs: SyncLog[] = [];

  const addLog = (message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info') => {
    logs.push({ timestamp: new Date().toISOString(), message, type });
  };

  addLog('Starting 2-way Notion Database <-> Google Calendar live sync cycle...', 'info');

  try {
    // 1. Fetch data from Notion Tasks and Google Calendar ("Notion" calendar)
    const [allNotionTasks, gcalEvents] = await Promise.all([
      fetchNotionTasks(),
      fetchGoogleCalendarEvents(),
    ]);

    const uncheckedNotionTasks = allNotionTasks.filter((t) => !t.isCompleted);

    addLog(
      `Fetched ${allNotionTasks.length} Notion Tasks (${uncheckedNotionTasks.length} unchecked), ${gcalEvents.length} Google Calendar events.`,
      'info'
    );

    const gcalEventIds = new Set(gcalEvents.map((e) => e.id));
    const notionTaskIds = new Set(allNotionTasks.map((t) => t.id));
    const allMappings = getMappings();

    const buildDescription = (notes?: string, url?: string) => {
      const parts: string[] = [];
      if (notes) parts.push(`Notes:\n${notes}`);
      if (url) parts.push(`Link: ${url}`);
      return parts.length > 0 ? parts.join('\n\n') : undefined;
    };

    // =========================================================================
    // 2. BI-DIRECTIONAL CHECKED / DELETED CONFLICT RESOLUTION
    // =========================================================================
    for (const mapping of [...allMappings]) {
      let isTaskNowCompletedOrDeleted = false;

      // Check Notion: either marked completed or page removed
      if (mapping.notionId) {
        const currentNotionTask = allNotionTasks.find((t) => t.id === mapping.notionId);
        if (!currentNotionTask || currentNotionTask.isCompleted) {
          isTaskNowCompletedOrDeleted = true;
        }
      }

      // Check Google Calendar: event removed from calendar
      if (mapping.gcalId && !gcalEventIds.has(mapping.gcalId)) {
        isTaskNowCompletedOrDeleted = true;
      }

      if (isTaskNowCompletedOrDeleted && !mapping.isCompleted) {
        addLog(`Task "${mapping.title}" completed/deleted on one platform. Syncing status...`, 'warning');

        // Mark as checked/completed in Notion (do not archive page)
        if (mapping.notionId && notionTaskIds.has(mapping.notionId)) {
          const currentNotionTask = allNotionTasks.find((t) => t.id === mapping.notionId);
          if (currentNotionTask && !currentNotionTask.isCompleted) {
            await updateNotionTask(mapping.notionId, { isCompleted: true });
            addLog(`Ticked task "${mapping.title}" as completed in Notion!`, 'success');
          }
        }

        // Delete from Google Calendar
        if (mapping.gcalId && gcalEventIds.has(mapping.gcalId)) {
          await deleteGoogleCalendarEvent(mapping.gcalId);
          mapping.gcalId = undefined;
          addLog(`Removed event "${mapping.title}" from Google Calendar!`, 'success');
        }

        mapping.isCompleted = true;
        upsertMapping(mapping);
      }
    }

    // =========================================================================
    // 3. NOTION TASKS -> GOOGLE CALENDAR
    // =========================================================================
    for (const nTask of uncheckedNotionTasks) {
      let mapping = findMappingByNotionId(nTask.id) || findMappingByTitle(nTask.title);
      const descriptionText = buildDescription(nTask.notes, nTask.url);

      if (mapping && !mapping.isCompleted) {
        const titleChanged = nTask.title !== mapping.title;
        const dateChanged = nTask.dueDate !== mapping.dueDate;

        if (titleChanged || dateChanged) {
          addLog(`Notion task "${mapping.title}" updated. Patching Google Calendar event...`, 'info');

          if (mapping.gcalId) {
            await updateGoogleCalendarEvent(mapping.gcalId, {
              title: nTask.title,
              dueDate: nTask.dueDate,
              description: descriptionText,
            });
          }

          mapping.title = nTask.title;
          mapping.dueDate = nTask.dueDate;
          mapping.notionId = nTask.id;
          upsertMapping(mapping);
        } else if (!mapping.notionId) {
          mapping.notionId = nTask.id;
          upsertMapping(mapping);
        }
      } else if (!mapping) {
        const existingGCalEvent = gcalEvents.find(
          (evt) => evt.summary.trim().toLowerCase() === nTask.title.trim().toLowerCase()
        );

        if (existingGCalEvent) {
          addLog(`Existing GCal event found for "${nTask.title}". Linking together...`, 'info');
          upsertMapping({
            id: nTask.id,
            notionId: nTask.id,
            gcalId: existingGCalEvent.id,
            title: nTask.title,
            dueDate: nTask.dueDate,
            isCompleted: false,
            lastUpdated: new Date().toISOString(),
            sourcePlatform: 'notion',
          });
        } else {
          addLog(`Creating Google Calendar event for Notion task "${nTask.title}"...`, 'info');
          const gcalId = await createGoogleCalendarEvent(nTask.title, nTask.dueDate, descriptionText);

          upsertMapping({
            id: nTask.id,
            notionId: nTask.id,
            gcalId: gcalId || undefined,
            title: nTask.title,
            dueDate: nTask.dueDate,
            isCompleted: false,
            lastUpdated: new Date().toISOString(),
            sourcePlatform: 'notion',
          });

          addLog(`Synced Notion task "${nTask.title}" to Google Calendar!`, 'success');
        }
      }
    }

    // =========================================================================
    // 4. GOOGLE CALENDAR -> NOTION TASKS
    // =========================================================================
    for (const evt of gcalEvents) {
      let mapping = findMappingByGCalId(evt.id) || findMappingByTitle(evt.summary);

      if (mapping && !mapping.isCompleted) {
        const titleChanged = evt.summary !== mapping.title;
        const dateChanged = evt.start !== mapping.dueDate;

        if (titleChanged || dateChanged) {
          addLog(`GCal event "${mapping.title}" date/title changed (new date: ${evt.start}). Updating Notion...`, 'info');

          if (mapping.notionId) {
            await updateNotionTask(mapping.notionId, {
              title: evt.summary,
              dueDate: evt.start,
            });
          }

          mapping.title = evt.summary;
          mapping.dueDate = evt.start;
          mapping.gcalId = evt.id;
          upsertMapping(mapping);
        } else if (!mapping.gcalId) {
          mapping.gcalId = evt.id;
          upsertMapping(mapping);
        }
      } else if (!mapping) {
        const existingNotionTask = allNotionTasks.find(
          (t) => t.title.trim().toLowerCase() === evt.summary.trim().toLowerCase() && !t.isCompleted
        );

        if (existingNotionTask) {
          addLog(`Linking GCal event "${evt.summary}" to existing Notion task...`, 'info');
          upsertMapping({
            id: existingNotionTask.id,
            notionId: existingNotionTask.id,
            gcalId: evt.id,
            title: evt.summary,
            dueDate: evt.start,
            isCompleted: false,
            lastUpdated: new Date().toISOString(),
            sourcePlatform: 'gcal',
          });
        } else {
          addLog(`Creating Notion task for GCal event "${evt.summary}"...`, 'info');
          const notionId = await createNotionTask(evt.summary, evt.start, false);

          if (notionId) {
            upsertMapping({
              id: notionId,
              notionId: notionId,
              gcalId: evt.id,
              title: evt.summary,
              dueDate: evt.start,
              isCompleted: false,
              lastUpdated: new Date().toISOString(),
              sourcePlatform: 'gcal',
            });
            addLog(`Synced Calendar event "${evt.summary}" to Notion!`, 'success');
          }
        }
      }
    }

    addLog('2-way Notion <-> Google Calendar live sync cycle finished clean.', 'success');
  } catch (error: any) {
    addLog(`Error during sync execution: ${error?.message || error}`, 'error');
  }

  return logs;
}
