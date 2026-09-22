import { fetchNotionTasks, updateNotionTask, createNotionTask, verifyNotionPageArchived, cleanGCalDescription } from './notion';
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
import { getMappings, upsertMapping, deleteMapping, findMappingByNotionId, findMappingByGCalId, findMappingByGTaskId, findMappingByTitle } from './syncStore';
import { getPendingMappings } from './pendingSyncStore';
import { runMidnightRollover } from './rolloverEngine';

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
    // 0. Automatically check for tasks past midnight and roll over to today
    const rolloverLogs = await runMidnightRollover();
    for (const rLog of rolloverLogs) {
      logs.push(rLog);
    }
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
      const cleanNotes = cleanGCalDescription(notes);
      if (cleanNotes) parts.push(cleanNotes);
      if (url && (!cleanNotes || !cleanNotes.toLowerCase().includes(url.toLowerCase()))) {
        parts.push(`Website: ${url}`);
      }
      if (notionPageUrl && (!cleanNotes || !cleanNotes.toLowerCase().includes(notionPageUrl.toLowerCase()))) {
        parts.push(`Notion Task: ${notionPageUrl}`);
      }
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
    // 2. COMPLETION, DATE REMOVAL & DELETION CASCADE WORKFLOW
    // =========================================================================
    const deletedNotionIds = new Set<string>();
    const deletedGCalIds = new Set<string>();
    const deletedGTaskIds = new Set<string>();

    // Map active Notion tasks by normalized title
    const activeNotionTasksByTitle = new Map<string, typeof allNotionTasks[0]>();
    for (const nt of allNotionTasks) {
      const key = nt.title.trim().toLowerCase().replace(/\s+/g, ' ');
      activeNotionTasksByTitle.set(key, nt);
    }

    // Pass 2A: Clean up Google Calendar events & Google Tasks for Notion tasks that have NO due date
    const pendingMappings = getPendingMappings();
    const pendingGTaskIds = new Set(pendingMappings.map((m) => m.gtaskId).filter(Boolean));

    for (const nt of allNotionTasks) {
      if (nt.isCompleted) continue;
      if (!nt.dueDate) {
        const titleKey = nt.title.trim().toLowerCase().replace(/\s+/g, ' ');
        const mapping = findMappingByNotionId(nt.id) || findMappingByTitle(nt.title);

        const targetGCal = (mapping?.gcalId ? activeGCalEvents.find((e) => e.id === mapping.gcalId) : undefined)
          || activeGCalEvents.find((e) => e.summary.trim().toLowerCase().replace(/\s+/g, ' ') === titleKey);

        if (targetGCal) {
          await deleteGoogleCalendarEvent(targetGCal.id);
          deletedGCalIds.add(targetGCal.id);
          addLog(`Removed "${nt.title}" from Google Calendar (no date assigned in Notion)`, 'info');
        }

        // Only delete from Google Tasks ("To Do") if it was explicitly associated with the dated mapping
        // and does NOT belong to the pendingSyncEngine ("Pending" list)
        if (mapping?.gtaskId && !pendingGTaskIds.has(mapping.gtaskId)) {
          const targetGTask = activeGTasks.find((t) => t.id === mapping.gtaskId);
          if (targetGTask) {
            await deleteGoogleTask(targetGTask.id);
            deletedGTaskIds.add(targetGTask.id);
            addLog(`Removed "${nt.title}" from Google Tasks (no date assigned in Notion)`, 'info');
          }
        }

        if (mapping) {
          deleteMapping(mapping.id);
          // Remove mapping from the local copy so it does not run through the completion cascade below
          const idx = allMappings.findIndex((m) => m.id === mapping.id);
          if (idx !== -1) allMappings.splice(idx, 1);
        }
      }
    }

    for (const mapping of [...allMappings]) {
      const currentNotionTask = (mapping.notionId ? allNotionTasks.find((t) => t.id === mapping.notionId) : undefined)
        || (mapping.title ? activeNotionTasksByTitle.get(mapping.title.trim().toLowerCase().replace(/\s+/g, ' ')) : undefined);
      const notionTaskExists = Boolean(currentNotionTask);
      const notionTaskCompleted = currentNotionTask ? currentNotionTask.isCompleted : false;

      // If this mapping is linked to a Notion task that has NO due date, do NOT process completion cascades for it
      if (currentNotionTask && !currentNotionTask.dueDate) {
        continue;
      }
      
      const gcalEvt = mapping.gcalId ? gcalEvents.find((e) => e.id === mapping.gcalId) : undefined;
      const isExplicitlyCancelledInGCal = gcalEvt ? Boolean(gcalEvt.isCancelled) : false;

      const gtaskItem = mapping.gtaskId ? gtaskItems.find((t) => t.id === mapping.gtaskId) : undefined;
      const gtaskCompleted = gtaskItem ? gtaskItem.status === 'completed' : false;

      // RULE: Notion is the single source of truth for task completion.
      // 1. If Notion task was ticked done, propagate completion to GCal and Google Tasks.
      const newlyCompletedInNotion = notionTaskCompleted && !mapping.isCompleted;

      if (newlyCompletedInNotion) {
        if (mapping.gcalId && gcalEventIds.has(mapping.gcalId)) {
          await deleteGoogleCalendarEvent(mapping.gcalId);
          addLog(`Deleted event "${mapping.title}" from Google Calendar`, 'success');
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

      // 2. If Notion task is active (NOT completed), it must NEVER be marked complete by Google Tasks.
      // If the Google Task was marked completed or stale, reactivate it in Google Tasks to keep them in sync.
      if (currentNotionTask && !notionTaskCompleted && gtaskCompleted && mapping.gtaskId) {
        await updateGoogleTask(mapping.gtaskId, { isCompleted: false });
        addLog(`Reopened Google Task "${mapping.title}" (Notion task is still active)`, 'info');
        mapping.isCompleted = false;
        upsertMapping(mapping);
        continue;
      }
    }

    // =========================================================================
    // 3. SEQUENTIAL CREATION WORKFLOW (GTask -> GCal -> Notion / GCal -> Notion & GTask / Notion -> GCal & GTask)
    // =========================================================================
    
    // Step A: Process Google Tasks -> ensure GCal event & Notion page exist, and propagate date/notes updates
    for (const gtask of activeGTasks) {
      if (gtask.status === 'completed' || deletedGTaskIds.has(gtask.id)) continue;
      const cleanTitleKey = gtask.title.trim().toLowerCase().replace(/\s+/g, ' ');

      // If this corresponds to an existing Notion task that has NO date, skip syncing to GCal/GTask
      const existingNotion = activeNotionTasksByTitle.get(cleanTitleKey);
      if (existingNotion && !existingNotion.dueDate) continue;

      let mapping = findMappingByGTaskId(gtask.id) || findMappingByTitle(gtask.title);
      const cleanGTaskDue = gtask.due ? (gtask.due.includes('T') ? gtask.due.split('T')[0] : gtask.due) : undefined;

      // Ensure Google Calendar event exists or update date/description if changed in GTasks
      let gcalId = mapping?.gcalId;
      if (!gcalId) {
        const existingGCal = activeGCalEvents.find((e) => e.summary.trim().toLowerCase().replace(/\s+/g, ' ') === cleanTitleKey);
        gcalId = existingGCal ? existingGCal.id : (await createGoogleCalendarEvent(gtask.title, gtask.due, gtask.notes)) || undefined;
      } else if (mapping && (mapping.dueDate !== cleanGTaskDue || (gtask.notes && mapping.description !== gtask.notes))) {
        await updateGoogleCalendarEvent(gcalId, { title: gtask.title, description: gtask.notes, dueDate: gtask.due });
        addLog(`Updated Google Calendar date/description for "${gtask.title}"`, 'info');
      }

      // Ensure Notion task page exists or update date/notes if changed in GTasks
      let notionId = mapping?.notionId;
      if (!notionId) {
        notionId = existingNotion ? existingNotion.id : (await createNotionTask(gtask.title, gtask.due, false, gtask.notes)) || undefined;
        if (notionId) {
          addLog(`Synced Google Task "${gtask.title}" to Notion database!`, 'success');
        }
      } else if (mapping && (mapping.dueDate !== cleanGTaskDue || (gtask.notes && mapping.description !== gtask.notes))) {
        await updateNotionTask(notionId, { notes: gtask.notes, title: gtask.title, dueDate: gtask.due });
        addLog(`Updated Notion date/notes for "${gtask.title}"`, 'info');
      }

      upsertMapping({
        id: mapping?.id || gtask.id,
        notionId,
        gcalId,
        gtaskId: gtask.id,
        title: gtask.title,
        dueDate: cleanGTaskDue,
        description: gtask.notes,
        isCompleted: false,
        lastUpdated: new Date().toISOString(),
        sourcePlatform: 'gtask',
      });
    }

    // Step B: Process Google Calendar Events -> ensure Notion task & Google Task exist, and propagate date/description updates
    for (const evt of activeGCalEvents) {
      if (deletedGCalIds.has(evt.id)) continue;
      const cleanTitleKey = evt.summary.trim().toLowerCase().replace(/\s+/g, ' ');

      // If this corresponds to an existing Notion task that has NO date, skip recreating/syncing
      const existingNotion = activeNotionTasksByTitle.get(cleanTitleKey);
      if (existingNotion && !existingNotion.dueDate) continue;

      let mapping = findMappingByGCalId(evt.id) || findMappingByTitle(evt.summary);
      const cleanGCalDue = evt.start ? (evt.start.includes('T') ? evt.start.split('T')[0] : evt.start) : undefined;

      let gtaskId = mapping?.gtaskId;
      if (!gtaskId) {
        const existingGTask = activeGTasks.find((t) => t.title.trim().toLowerCase().replace(/\s+/g, ' ') === cleanTitleKey);
        gtaskId = existingGTask ? existingGTask.id : (await createGoogleTask(evt.summary, evt.start, evt.description)) || undefined;
      } else if (mapping && (mapping.dueDate !== cleanGCalDue || (evt.description && mapping.description !== evt.description))) {
        await updateGoogleTask(gtaskId, { notes: evt.description, title: evt.summary, dueDate: evt.start });
        addLog(`Updated Google Task date/notes for "${evt.summary}"`, 'info');
      }

      let notionId = mapping?.notionId;
      if (!notionId) {
        notionId = existingNotion ? existingNotion.id : (await createNotionTask(evt.summary, evt.start, false, evt.description)) || undefined;
        if (notionId) {
          addLog(`Synced Google Calendar event "${evt.summary}" to Notion database!`, 'success');
        }
      } else if (mapping && (mapping.dueDate !== evt.start && mapping.dueDate !== cleanGCalDue || (evt.description && mapping.description !== evt.description))) {
        await updateNotionTask(notionId, { notes: evt.description, title: evt.summary, dueDate: evt.start });
        addLog(`Updated Notion date/notes for "${evt.summary}"`, 'info');
      }

      upsertMapping({
        id: mapping?.id || evt.id,
        notionId,
        gcalId: evt.id,
        gtaskId,
        title: evt.summary,
        dueDate: evt.start || cleanGCalDue,
        description: evt.description,
        isCompleted: false,
        lastUpdated: new Date().toISOString(),
        sourcePlatform: 'gcal',
      });
    }

    // Step C: Process Notion Tasks -> only sync tasks that have a date to Google Calendar & Tasks
    for (const nTask of allNotionTasks) {
      if (nTask.isCompleted || deletedNotionIds.has(nTask.id)) continue;
      // Strictly skip tasks that do not have a date
      if (!nTask.dueDate) continue;
      const cleanTitleKey = nTask.title.trim().toLowerCase().replace(/\s+/g, ' ');

      let mapping = findMappingByNotionId(nTask.id) || findMappingByTitle(nTask.title);
      const descriptionText = buildDescription(nTask.notes, nTask.url, nTask.notionPageUrl);
      const cleanNotionDue = nTask.dueDate ? (nTask.dueDate.includes('T') ? nTask.dueDate.split('T')[0] : nTask.dueDate) : undefined;

      let gcalId = mapping?.gcalId;
      if (!gcalId) {
        const existingGCal = activeGCalEvents.find((e) => e.summary.trim().toLowerCase().replace(/\s+/g, ' ') === cleanTitleKey);
        gcalId = existingGCal ? existingGCal.id : (await createGoogleCalendarEvent(nTask.title, nTask.dueDate, descriptionText)) || undefined;
      } else if (mapping && (mapping.dueDate !== nTask.dueDate && mapping.dueDate !== cleanNotionDue || mapping.description !== descriptionText)) {
        await updateGoogleCalendarEvent(gcalId, { title: nTask.title, description: descriptionText, dueDate: nTask.dueDate });
        addLog(`Updated Google Calendar date/description for "${nTask.title}"`, 'info');
      }

      let gtaskId = mapping?.gtaskId;
      if (!gtaskId) {
        const existingGTask = activeGTasks.find((t) => t.title.trim().toLowerCase().replace(/\s+/g, ' ') === cleanTitleKey);
        gtaskId = existingGTask ? existingGTask.id : (await createGoogleTask(nTask.title, nTask.dueDate, descriptionText)) || undefined;
      } else if (mapping && (mapping.dueDate !== nTask.dueDate && mapping.dueDate !== cleanNotionDue || mapping.description !== descriptionText)) {
        await updateGoogleTask(gtaskId, { notes: descriptionText, title: nTask.title, dueDate: nTask.dueDate });
        addLog(`Updated Google Task date/notes for "${nTask.title}"`, 'info');
      }

      upsertMapping({
        id: mapping?.id || nTask.id,
        notionId: nTask.id,
        gcalId,
        gtaskId,
        title: nTask.title,
        dueDate: nTask.dueDate || cleanNotionDue,
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


