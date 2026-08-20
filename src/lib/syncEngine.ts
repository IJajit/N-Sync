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
    // 1. Fetch current items from Notion Tasks, Google Calendar, and Google Tasks ("To Do List")
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
    // 1.5 AUTOMATED DEDUPLICATION PASS
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
    // 2. COMPLETION & DELETION CASCADE WORKFLOW
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

      const newlyCompletedInNotion = notionTaskCompleted && !mapping.isCompleted;
      const newlyCompletedInGTask = gtaskCompleted && !mapping.isCompleted;
      const deletedFromGCal = isExplicitlyCancelledInGCal && !mapping.isCompleted;

      // Workflow: Checking in Notion or GTasks -> delete GCal event & check in remaining services
      // Workflow: Deleting GCal event -> check Notion task & tick mark GTask
      if (newlyCompletedInNotion || newlyCompletedInGTask || deletedFromGCal) {
        if (mapping.gcalId && gcalEventIds.has(mapping.gcalId)) {
          await deleteGoogleCalendarEvent(mapping.gcalId);
          addLog(`Deleted event "${mapping.title}" from Google Calendar`, 'success');
        }

        if (mapping.notionId && notionTaskExists && !notionTaskCompleted) {
          await updateNotionTask(mapping.notionId, { isCompleted: true });
          addLog(`Ticked task "${mapping.title}" in Notion database`, 'success');
        }

        if (mapping.gtaskId && gtaskItem && gtaskItem.status !== 'completed') {
          await updateGoogleTask(mapping.gtaskId, { isCompleted: true });
          addLog(`Ticked task "${mapping.title}" in Google Tasks`, 'success');
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
    // 3. SEQUENTIAL CREATION WORKFLOW (GTask -> GCal -> Notion / GCal -> Notion & GTask / Notion -> GCal & GTask)
    // =========================================================================
    
    // Step A: Process Google Tasks -> ensure GCal event exists, then trigger Notion database task creation
    for (const gtask of activeGTasks) {
      if (gtask.status === 'completed' || deletedGTaskIds.has(gtask.id)) continue;
      const cleanTitleKey = gtask.title.trim().toLowerCase().replace(/\s+/g, ' ');

      let mapping = findMappingByGTaskId(gtask.id) || findMappingByTitle(gtask.title);

      // Ensure Google Calendar event exists
      let gcalId = mapping?.gcalId;
      if (!gcalId) {
        const existingGCal = activeGCalEvents.find((e) => e.summary.trim().toLowerCase().replace(/\s+/g, ' ') === cleanTitleKey);
        gcalId = existingGCal ? existingGCal.id : (await createGoogleCalendarEvent(gtask.title, gtask.due, gtask.notes)) || undefined;
      }

      // Ensure Notion task page exists
      let notionId = mapping?.notionId;
      if (!notionId) {
        const existingNotion = allNotionTasks.find((t) => t.title.trim().toLowerCase().replace(/\s+/g, ' ') === cleanTitleKey);
        notionId = existingNotion ? existingNotion.id : (await createNotionTask(gtask.title, gtask.due, false, gtask.notes)) || undefined;
        if (notionId) {
          addLog(`Synced Google Task "${gtask.title}" to Notion database!`, 'success');
        }
      }

      upsertMapping({
        id: mapping?.id || gtask.id,
        notionId,
        gcalId,
        gtaskId: gtask.id,
        title: gtask.title,
        dueDate: gtask.due,
        description: gtask.notes,
        isCompleted: false,
        lastUpdated: new Date().toISOString(),
        sourcePlatform: 'gtask',
      });
    }

    // Step B: Process Google Calendar Events -> ensure Notion task & Google Task exist
    for (const evt of activeGCalEvents) {
      if (deletedGCalIds.has(evt.id)) continue;
      const cleanTitleKey = evt.summary.trim().toLowerCase().replace(/\s+/g, ' ');

      let mapping = findMappingByGCalId(evt.id) || findMappingByTitle(evt.summary);

      let gtaskId = mapping?.gtaskId;
      if (!gtaskId) {
        const existingGTask = activeGTasks.find((t) => t.title.trim().toLowerCase().replace(/\s+/g, ' ') === cleanTitleKey);
        gtaskId = existingGTask ? existingGTask.id : (await createGoogleTask(evt.summary, evt.start, evt.description)) || undefined;
      }

      let notionId = mapping?.notionId;
      if (!notionId) {
        const existingNotion = allNotionTasks.find((t) => t.title.trim().toLowerCase().replace(/\s+/g, ' ') === cleanTitleKey);
        notionId = existingNotion ? existingNotion.id : (await createNotionTask(evt.summary, evt.start, false, evt.description)) || undefined;
        if (notionId) {
          addLog(`Synced Google Calendar event "${evt.summary}" to Notion database!`, 'success');
        }
      }

      upsertMapping({
        id: mapping?.id || evt.id,
        notionId,
        gcalId: evt.id,
        gtaskId,
        title: evt.summary,
        dueDate: evt.start,
        description: evt.description,
        isCompleted: false,
        lastUpdated: new Date().toISOString(),
        sourcePlatform: 'gcal',
      });
    }

    // Step C: Process Notion Tasks -> ensure GCal event & Google Task exist
    for (const nTask of allNotionTasks) {
      if (nTask.isCompleted || deletedNotionIds.has(nTask.id)) continue;
      const cleanTitleKey = nTask.title.trim().toLowerCase().replace(/\s+/g, ' ');

      let mapping = findMappingByNotionId(nTask.id) || findMappingByTitle(nTask.title);
      const descriptionText = buildDescription(nTask.notes, nTask.url, nTask.notionPageUrl);

      let gcalId = mapping?.gcalId;
      if (!gcalId) {
        const existingGCal = activeGCalEvents.find((e) => e.summary.trim().toLowerCase().replace(/\s+/g, ' ') === cleanTitleKey);
        gcalId = existingGCal ? existingGCal.id : (await createGoogleCalendarEvent(nTask.title, nTask.dueDate, descriptionText)) || undefined;
      }

      let gtaskId = mapping?.gtaskId;
      if (!gtaskId) {
        const existingGTask = activeGTasks.find((t) => t.title.trim().toLowerCase().replace(/\s+/g, ' ') === cleanTitleKey);
        gtaskId = existingGTask ? existingGTask.id : (await createGoogleTask(nTask.title, nTask.dueDate, descriptionText)) || undefined;
      }

      upsertMapping({
        id: mapping?.id || nTask.id,
        notionId: nTask.id,
        gcalId,
        gtaskId,
        title: nTask.title,
        dueDate: nTask.dueDate,
        description: descriptionText,
        isCompleted: false,
        lastUpdated: new Date().toISOString(),
        sourcePlatform: 'notion',
      });
    }
  } catch (error: any) {
    addLog(`Error during 3-way sync execution: ${error?.message || error}`, 'error');
  }

  return logs;
}


