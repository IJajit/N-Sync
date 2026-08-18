import { fetchNotionTasks, createNotionTask, updateNotionTask, deleteNotionTaskPage, verifyNotionPageArchived } from './notion';
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

  try {
    // 1. Fetch data from Notion Tasks and Google Calendar ("Notion" calendar)
    const [allNotionTasks, gcalEvents] = await Promise.all([
      fetchNotionTasks(),
      fetchGoogleCalendarEvents(),
    ]);

    const activeGCalEvents = gcalEvents.filter((e) => !e.isCancelled);
    const uncheckedNotionTasks = allNotionTasks.filter((t) => !t.isCompleted);
    const gcalEventIds = new Set(activeGCalEvents.map((e) => e.id));
    const notionTaskIds = new Set(allNotionTasks.map((t) => t.id));
    const allMappings = getMappings();

    const buildDescription = (notes?: string, url?: string) => {
      const parts: string[] = [];
      if (notes) parts.push(`Notes:\n${notes}`);
      if (url) parts.push(`Link: ${url}`);
      return parts.length > 0 ? parts.join('\n\n') : undefined;
    };

    // =========================================================================
    // 2. SAFE BI-DIRECTIONAL DELETION & CONFLICT RESOLUTION
    // =========================================================================
    const deletedNotionIds = new Set<string>();
    const deletedGCalIds = new Set<string>();
    const deletedTitles = new Set<string>();

    for (const mapping of [...allMappings]) {
      if (mapping.isCompleted) continue;

      const notionTaskExists = mapping.notionId ? notionTaskIds.has(mapping.notionId) : false;
      const currentNotionTask = mapping.notionId ? allNotionTasks.find((t) => t.id === mapping.notionId) : undefined;
      const notionTaskCompleted = currentNotionTask ? currentNotionTask.isCompleted : false;
      const gcalEvt = mapping.gcalId ? gcalEvents.find((e) => e.id === mapping.gcalId) : undefined;
      const isExplicitlyCancelledInGCal = gcalEvt ? Boolean(gcalEvt.isCancelled) : false;

      // Case A: Task deleted or completed in Notion
      if (mapping.notionId && (!notionTaskExists || notionTaskCompleted)) {
        const isNotionPageArchived = !notionTaskExists ? await verifyNotionPageArchived(mapping.notionId) : false;

        if (isNotionPageArchived || notionTaskCompleted) {
          if (mapping.gcalId && gcalEventIds.has(mapping.gcalId)) {
            await deleteGoogleCalendarEvent(mapping.gcalId);
            addLog(`Deleted event "${mapping.title}" from Google Calendar (Notion task removed/completed)`, 'success');
          }
          if (mapping.notionId) deletedNotionIds.add(mapping.notionId);
          if (mapping.gcalId) deletedGCalIds.add(mapping.gcalId);
          deletedTitles.add(mapping.title.trim().toLowerCase());

          mapping.isCompleted = true;
          mapping.gcalId = undefined;
          upsertMapping(mapping);
          continue;
        }
      }

      // Case B: Event explicitly cancelled/deleted in Google Calendar
      if (mapping.gcalId && isExplicitlyCancelledInGCal) {
        if (mapping.notionId) deletedNotionIds.add(mapping.notionId);
        if (mapping.gcalId) deletedGCalIds.add(mapping.gcalId);
        deletedTitles.add(mapping.title.trim().toLowerCase());

        mapping.isCompleted = true;
        mapping.notionId = undefined;
        upsertMapping(mapping);
        continue;
      }
    }

    // =========================================================================
    // 3. NOTION TASKS -> GOOGLE CALENDAR (Skip Past Tasks)
    // =========================================================================
    const todayStr = new Date().toISOString().split('T')[0];

    for (const nTask of uncheckedNotionTasks) {
      const normalizedTitle = nTask.title.trim().toLowerCase();
      if (deletedNotionIds.has(nTask.id)) {
        continue; // Skip tasks explicitly deleted in Step 2
      }

      let mapping = findMappingByNotionId(nTask.id);
      const descriptionText = buildDescription(nTask.notes, nTask.url);

      if (mapping && mapping.isCompleted) {
        continue; // Do not resurrect completed/deleted mapping
      }

      if (mapping && !mapping.isCompleted) {
        const titleChanged = nTask.title !== mapping.title;
        const dateChanged = nTask.dueDate !== mapping.dueDate;

        if (titleChanged || dateChanged) {
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
          addLog(`Updated Google Calendar event for Notion task "${nTask.title}"`, 'success');
        } else if (!mapping.notionId) {
          mapping.notionId = nTask.id;
          upsertMapping(mapping);
        }
      } else if (!mapping) {
        const existingGCalEvent = gcalEvents.find(
          (evt) => evt.summary.trim().toLowerCase() === normalizedTitle && !evt.isCancelled
        );

        if (existingGCalEvent) {
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
          addLog(`Linked Notion task "${nTask.title}" to existing Google Calendar event`, 'success');
        } else {
          const gcalId = await createGoogleCalendarEvent(nTask.title, nTask.dueDate, descriptionText);
          if (gcalId) {
            upsertMapping({
              id: nTask.id,
              notionId: nTask.id,
              gcalId: gcalId,
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
    }

    // =========================================================================
    // 4. GOOGLE CALENDAR -> NOTION TASKS (Skip Past Events & Anti-Duplication)
    // =========================================================================
    for (const evt of gcalEvents) {
      const normalizedSummary = evt.summary.trim().toLowerCase();

      // Skip deleted events or past events
      if (deletedGCalIds.has(evt.id) || deletedTitles.has(normalizedSummary)) {
        continue;
      }

      if (evt.start && evt.start < todayStr) {
        continue;
      }

      let mapping = findMappingByGCalId(evt.id) || findMappingByTitle(evt.summary);

      if (mapping && mapping.isCompleted) {
        continue; // Do not resurrect completed/deleted mapping
      }

      if (mapping && !mapping.isCompleted) {
        const titleChanged = evt.summary !== mapping.title;
        const dateChanged = evt.start !== mapping.dueDate;

        if (titleChanged || dateChanged) {
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
          addLog(`Updated Notion task for GCal event "${evt.summary}"`, 'success');
        } else if (!mapping.gcalId) {
          mapping.gcalId = evt.id;
          upsertMapping(mapping);
        }
      } else if (!mapping) {
        const existingNotionTask = allNotionTasks.find(
          (t) => t.title.trim().toLowerCase() === normalizedSummary
        );

        if (existingNotionTask) {
          upsertMapping({
            id: existingNotionTask.id,
            notionId: existingNotionTask.id,
            gcalId: evt.id,
            title: evt.summary,
            dueDate: evt.start,
            isCompleted: existingNotionTask.isCompleted,
            lastUpdated: new Date().toISOString(),
            sourcePlatform: 'gcal',
          });
        }
      }
    }

    if (logs.length === 0) {
      addLog(`Live sync active - verified ${uncheckedNotionTasks.length} active Notion tasks & ${gcalEvents.length} Notion calendar events.`, 'info');
    }
  } catch (error: any) {
    addLog(`Error during sync execution: ${error?.message || error}`, 'error');
  }

  return logs;
}
