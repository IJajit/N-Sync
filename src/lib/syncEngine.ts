import { fetchNotionTasks, updateNotionTask, createNotionTask, verifyNotionPageArchived } from './notion';
import {
  fetchGoogleCalendarEvents,
  createGoogleCalendarEvent,
  updateGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
  GCalEventItem,
  fetchGoogleTasks,
  createGoogleTask,
  updateGoogleTask,
  deleteGoogleTask,
  GTaskItem,
} from './google';
import { getMappings, upsertMapping, findMappingByNotionId, findMappingByGCalId, findMappingByGTaskId, findMappingByTitle } from './syncStore';

export interface SyncLog {
  timestamp: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
}

export async function runTwoWaySync(): Promise<SyncLog[]> {
  const logs: SyncLog[] = [];

  const addLog = (message: string, type: SyncLog['type'] = 'info') => {
    logs.push({
      timestamp: new Date().toISOString(),
      message,
      type,
    });
  };

  try {
    // 1. Fetch data from Notion Tasks, Google Calendar, and Google Tasks ("To Do List")
    const [allNotionTasks, gcalEvents, gtaskItems] = await Promise.all([
      fetchNotionTasks(),
      fetchGoogleCalendarEvents(),
      fetchGoogleTasks(),
    ]);

    const activeGCalEvents = gcalEvents.filter((e) => !e.isCancelled);
    const activeGTasks = gtaskItems.filter((t) => !t.isDeleted);
    
    const gcalEventIds = new Set(activeGCalEvents.map((e) => e.id));
    const notionTaskIds = new Set(allNotionTasks.map((t) => t.id));
    const gtaskIds = new Set(activeGTasks.map((t) => t.id));
    const allMappings = getMappings();

    const buildDescription = (notes?: string, url?: string, notionPageUrl?: string) => {
      const parts: string[] = [];
      if (notes) parts.push(`Notes:\n${notes}`);
      if (url) parts.push(`Website: ${url}`);
      if (notionPageUrl) parts.push(`Notion Task: ${notionPageUrl}`);
      return parts.length > 0 ? parts.join('\n\n') : undefined;
    };

    // =========================================================================
    // 1.5 AUTOMATED GOOGLE CALENDAR & TASKS DEDUPLICATION PASS
    // =========================================================================
    const activeGCalEventsByTitle = new Map<string, GCalEventItem[]>();
    for (const evt of activeGCalEvents) {
      const titleKey = evt.summary.trim().toLowerCase().replace(/\s+/g, ' ');
      if (!activeGCalEventsByTitle.has(titleKey)) {
        activeGCalEventsByTitle.set(titleKey, []);
      }
      activeGCalEventsByTitle.get(titleKey)!.push(evt);
    }

    for (const [titleKey, evts] of activeGCalEventsByTitle.entries()) {
      if (evts.length > 1) {
        for (let i = 1; i < evts.length; i++) {
          const duplicateEvt = evts[i];
          await deleteGoogleCalendarEvent(duplicateEvt.id);
          addLog(`Cleaned up duplicate event "${duplicateEvt.summary}" from Google Calendar`, 'info');
        }
      }
    }

    const activeGTasksByTitle = new Map<string, GTaskItem[]>();
    for (const task of activeGTasks) {
      const titleKey = task.title.trim().toLowerCase().replace(/\s+/g, ' ');
      if (!activeGTasksByTitle.has(titleKey)) {
        activeGTasksByTitle.set(titleKey, []);
      }
      activeGTasksByTitle.get(titleKey)!.push(task);
    }

    for (const [titleKey, tasks] of activeGTasksByTitle.entries()) {
      if (tasks.length > 1) {
        for (let i = 1; i < tasks.length; i++) {
          const duplicateTask = tasks[i];
          await deleteGoogleTask(duplicateTask.id);
          addLog(`Cleaned up duplicate task "${duplicateTask.title}" from Google Tasks`, 'info');
        }
      }
    }

    // =========================================================================
    // 2. SAFE 3-WAY DELETION & COMPLETION RESOLUTION
    // =========================================================================
    const deletedNotionIds = new Set<string>();
    const deletedGCalIds = new Set<string>();
    const deletedGTaskIds = new Set<string>();

    for (const mapping of [...allMappings]) {
      const notionTaskExists = mapping.notionId ? notionTaskIds.has(mapping.notionId) : false;
      const currentNotionTask = mapping.notionId ? allNotionTasks.find((t) => t.id === mapping.notionId) : undefined;
      const notionTaskCompleted = currentNotionTask ? currentNotionTask.isCompleted : false;
      
      const gcalEvt = mapping.gcalId ? gcalEvents.find((e) => e.id === mapping.gcalId) : undefined;
      const isExplicitlyCancelledInGCal = gcalEvt ? Boolean(gcalEvt.isCancelled) : false;

      const gtaskItem = mapping.gtaskId ? gtaskItems.find((t) => t.id === mapping.gtaskId) : undefined;
      const gtaskCompleted = gtaskItem ? gtaskItem.status === 'completed' : false;

      // Detect if item completed anywhere in the 3 platforms:
      const newlyCompletedInNotion = notionTaskCompleted && !mapping.isCompleted;
      const newlyCompletedInGTask = gtaskCompleted && !mapping.isCompleted;
      const deletedFromGCal = isExplicitlyCancelledInGCal && !mapping.isCompleted;

      if (newlyCompletedInNotion || newlyCompletedInGTask || deletedFromGCal) {
        // Mark as completed across Notion & Google Tasks, and remove from Google Calendar
        if (mapping.gcalId && gcalEventIds.has(mapping.gcalId)) {
          await deleteGoogleCalendarEvent(mapping.gcalId);
          addLog(`Removed event "${mapping.title}" from Google Calendar`, 'success');
        }

        if (mapping.notionId && notionTaskExists && !notionTaskCompleted) {
          await updateNotionTask(mapping.notionId, { isCompleted: true });
          addLog(`Checked task "${mapping.title}" in Notion`, 'success');
        }

        if (mapping.gtaskId && gtaskItem && gtaskItem.status !== 'completed') {
          await updateGoogleTask(mapping.gtaskId, { isCompleted: true });
          addLog(`Completed task "${mapping.title}" in Google Tasks`, 'success');
        }

        if (mapping.notionId) deletedNotionIds.add(mapping.notionId);
        if (mapping.gcalId) deletedGCalIds.add(mapping.gcalId);
        if (mapping.gtaskId) deletedGTaskIds.add(mapping.gtaskId);

        mapping.isCompleted = true;
        mapping.gcalId = undefined;
        upsertMapping(mapping);
        continue;
      }
    }

    // =========================================================================
    // 3. RECONCILE & SYNC ACROSS ALL 3 PLATFORMS
    // =========================================================================
    const modifiedInRun = new Set<string>();

    // Process Notion Tasks -> GCal & GTasks
    for (const nTask of allNotionTasks) {
      const cleanTitleKey = nTask.title.trim().toLowerCase().replace(/\s+/g, ' ');

      if (deletedNotionIds.has(nTask.id)) continue;

      let mapping = findMappingByNotionId(nTask.id) || findMappingByTitle(nTask.title);
      const descriptionText = buildDescription(nTask.notes, nTask.url, nTask.notionPageUrl);

      // Handle Resync if user UNCHECKED a task in Notion
      if (mapping && mapping.isCompleted && !nTask.isCompleted) {
        mapping.isCompleted = false;
        const gcalId = await createGoogleCalendarEvent(nTask.title, nTask.dueDate, descriptionText);
        if (!mapping.gtaskId) {
          mapping.gtaskId = (await createGoogleTask(nTask.title, nTask.dueDate, descriptionText, false)) || undefined;
        } else {
          await updateGoogleTask(mapping.gtaskId, { isCompleted: false, title: nTask.title, dueDate: nTask.dueDate });
        }
        mapping.gcalId = gcalId || undefined;
        mapping.lastUpdated = new Date().toISOString();
        upsertMapping(mapping);
        addLog(`Resynced unchecked task "${nTask.title}" back to Google Calendar & Google Tasks!`, 'success');
        continue;
      }

      if (nTask.isCompleted) continue;

      if (!mapping) {
        // Create in Google Calendar & Google Tasks
        const existingGCal = activeGCalEvents.find((e) => e.summary.trim().toLowerCase().replace(/\s+/g, ' ') === cleanTitleKey);
        const existingGTask = activeGTasks.find((t) => t.title.trim().toLowerCase().replace(/\s+/g, ' ') === cleanTitleKey);

        const gcalId = existingGCal ? existingGCal.id : await createGoogleCalendarEvent(nTask.title, nTask.dueDate, descriptionText);
        const gtaskId = existingGTask ? existingGTask.id : await createGoogleTask(nTask.title, nTask.dueDate, descriptionText);

        upsertMapping({
          id: nTask.id,
          notionId: nTask.id,
          gcalId: gcalId || undefined,
          gtaskId: gtaskId || undefined,
          title: nTask.title,
          dueDate: nTask.dueDate,
          description: descriptionText,
          isCompleted: false,
          lastUpdated: new Date().toISOString(),
          sourcePlatform: 'notion',
        });
        addLog(`Synced Notion task "${nTask.title}" to Google Calendar & Google Tasks!`, 'success');
      } else if (!mapping.isCompleted) {
        // Ensure GTasks has this task
        if (!mapping.gtaskId) {
          const existingGTask = activeGTasks.find((t) => t.title.trim().toLowerCase().replace(/\s+/g, ' ') === cleanTitleKey);
          mapping.gtaskId = existingGTask ? existingGTask.id : ((await createGoogleTask(nTask.title, nTask.dueDate, descriptionText)) || undefined);
          upsertMapping(mapping);
        }
        // Ensure GCal has this event
        if (!mapping.gcalId) {
          const existingGCal = activeGCalEvents.find((e) => e.summary.trim().toLowerCase().replace(/\s+/g, ' ') === cleanTitleKey);
          mapping.gcalId = existingGCal ? existingGCal.id : ((await createGoogleCalendarEvent(nTask.title, nTask.dueDate, descriptionText)) || undefined);
          upsertMapping(mapping);
        }
      }
    }

    // Process Google Tasks ("To Do List") -> Notion & GCal
    for (const gtask of activeGTasks) {
      const cleanTitleKey = gtask.title.trim().toLowerCase().replace(/\s+/g, ' ');
      if (deletedGTaskIds.has(gtask.id)) continue;

      let mapping = findMappingByGTaskId(gtask.id) || findMappingByTitle(gtask.title);

      if (!mapping) {
        const existingNotionTask = allNotionTasks.find((t) => t.title.trim().toLowerCase().replace(/\s+/g, ' ') === cleanTitleKey);
        const existingGCal = activeGCalEvents.find((e) => e.summary.trim().toLowerCase().replace(/\s+/g, ' ') === cleanTitleKey);

        const notionId = existingNotionTask ? existingNotionTask.id : await createNotionTask(gtask.title, gtask.due, gtask.status === 'completed', gtask.notes);
        const gcalId = existingGCal ? existingGCal.id : await createGoogleCalendarEvent(gtask.title, gtask.due, gtask.notes);

        upsertMapping({
          id: gtask.id,
          notionId: notionId || undefined,
          gcalId: gcalId || undefined,
          gtaskId: gtask.id,
          title: gtask.title,
          dueDate: gtask.due,
          description: gtask.notes,
          isCompleted: gtask.status === 'completed',
          lastUpdated: new Date().toISOString(),
          sourcePlatform: 'gtask',
        });
        addLog(`Linked Google Task "${gtask.title}" with Notion & Google Calendar!`, 'success');
      } else if (!mapping.notionId) {
        const existingNotionTask = allNotionTasks.find((t) => t.title.trim().toLowerCase().replace(/\s+/g, ' ') === cleanTitleKey);
        const notionId = existingNotionTask ? existingNotionTask.id : await createNotionTask(gtask.title, gtask.due, gtask.status === 'completed', gtask.notes);
        if (notionId) {
          mapping.notionId = notionId;
          upsertMapping(mapping);
          addLog(`Created Notion task for Google Task "${gtask.title}"`, 'success');
        }
      }
    }

    // Process Google Calendar Events -> Notion & GTasks
    for (const evt of activeGCalEvents) {
      const cleanTitleKey = evt.summary.trim().toLowerCase().replace(/\s+/g, ' ');
      if (deletedGCalIds.has(evt.id)) continue;

      let mapping = findMappingByGCalId(evt.id) || findMappingByTitle(evt.summary);

      if (!mapping) {
        const existingNotionTask = allNotionTasks.find((t) => t.title.trim().toLowerCase().replace(/\s+/g, ' ') === cleanTitleKey);
        const existingGTask = activeGTasks.find((t) => t.title.trim().toLowerCase().replace(/\s+/g, ' ') === cleanTitleKey);

        const notionId = existingNotionTask ? existingNotionTask.id : await createNotionTask(evt.summary, evt.start, false, evt.description);
        const gtaskId = existingGTask ? existingGTask.id : await createGoogleTask(evt.summary, evt.start, evt.description);

        upsertMapping({
          id: evt.id,
          notionId: notionId || undefined,
          gcalId: evt.id,
          gtaskId: gtaskId || undefined,
          title: evt.summary,
          dueDate: evt.start,
          description: evt.description,
          isCompleted: false,
          lastUpdated: new Date().toISOString(),
          sourcePlatform: 'gcal',
        });
        addLog(`Synced Google Calendar event "${evt.summary}" to Notion & Google Tasks!`, 'success');
      } else {
        if (!mapping.notionId) {
          const existingNotionTask = allNotionTasks.find((t) => t.title.trim().toLowerCase().replace(/\s+/g, ' ') === cleanTitleKey);
          const notionId = existingNotionTask ? existingNotionTask.id : await createNotionTask(evt.summary, evt.start, false, evt.description);
          if (notionId) {
            mapping.notionId = notionId;
            upsertMapping(mapping);
            addLog(`Created Notion task for Google Calendar event "${evt.summary}"`, 'success');
          }
        }
        if (!mapping.gtaskId) {
          const existingGTask = activeGTasks.find((t) => t.title.trim().toLowerCase().replace(/\s+/g, ' ') === cleanTitleKey);
          const gtaskId = existingGTask ? existingGTask.id : await createGoogleTask(evt.summary, evt.start, evt.description);
          if (gtaskId) {
            mapping.gtaskId = gtaskId;
            upsertMapping(mapping);
            addLog(`Created Google Task for Google Calendar event "${evt.summary}"`, 'success');
          }
        }
      }
    }
  } catch (error: any) {
    addLog(`Error during 3-way sync execution: ${error?.message || error}`, 'error');
  }

  return logs;
}

