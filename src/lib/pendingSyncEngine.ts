import { fetchNotionTasks, updateNotionTask, createNotionTask, deleteNotionTaskPage } from './notion';
import {
  fetchGooglePendingTasks,
  createGooglePendingTask,
  updateGooglePendingTask,
  deleteGooglePendingTask,
  GooglePendingTaskItem,
} from './googlePendingTasks';
import {
  getPendingMappings,
  upsertPendingMapping,
  deletePendingMapping,
  findPendingMappingByNotionId,
  findPendingMappingByGTaskId,
  findPendingMappingByTitle,
} from './pendingSyncStore';

export interface PendingSyncLog {
  timestamp: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
}

export async function runPendingSync(): Promise<PendingSyncLog[]> {
  const logs: PendingSyncLog[] = [];

  const addLog = (message: string, type: PendingSyncLog['type'] = 'info') => {
    logs.push({
      timestamp: new Date().toISOString(),
      message,
      type,
    });
  };

  try {
    // 1. Fetch current items from Notion and Google Tasks "Pending" list
    const [allNotionTasks, pendingGTasks] = await Promise.all([
      fetchNotionTasks(),
      fetchGooglePendingTasks(),
    ]);

    // All Notion tasks without a date
    const datelessNotionTasks = allNotionTasks.filter((t) => !t.dueDate);
    const activeDatelessNotionTasks = datelessNotionTasks.filter((t) => !t.isCompleted);
    const datelessNotionIds = new Set(datelessNotionTasks.map((t) => t.id));

    // Active Google Tasks in "Pending" list (not permanently deleted in Google)
    const activePendingGTasks = pendingGTasks.filter((t) => !t.isDeleted);
    const activePendingGTaskIds = new Set(activePendingGTasks.map((t) => t.id));

    const allMappings = getPendingMappings();

    const datelessNotionByTitle = new Map<string, typeof datelessNotionTasks[0]>();
    for (const t of datelessNotionTasks) {
      datelessNotionByTitle.set(t.title.trim().toLowerCase().replace(/\s+/g, ' '), t);
    }

    const pendingGTasksByTitle = new Map<string, GooglePendingTaskItem>();
    for (const t of activePendingGTasks) {
      pendingGTasksByTitle.set(t.title.trim().toLowerCase().replace(/\s+/g, ' '), t);
    }

    // Sets to prevent re-processing items deleted/completed in this cycle
    const handledNotionIds = new Set<string>();
    const handledGTaskIds = new Set<string>();

    // =========================================================================
    // 2. PASS A: DELETION SYNC
    // If an item existed in our mapping but was deleted/trashed in Notion or Google Tasks
    // =========================================================================
    for (const mapping of [...allMappings]) {
      const cleanTitleKey = mapping.title.trim().toLowerCase().replace(/\s+/g, ' ');

      const notionTaskExists = mapping.notionId ? datelessNotionIds.has(mapping.notionId) : datelessNotionByTitle.has(cleanTitleKey);
      const gtaskItem = mapping.gtaskId ? pendingGTasks.find((t) => t.id === mapping.gtaskId) : pendingGTasksByTitle.get(cleanTitleKey);
      const gtaskExists = Boolean(gtaskItem && !gtaskItem.isDeleted);

      // Deleted in Google Tasks -> delete/archive corresponding Notion task
      if (!gtaskExists && mapping.gtaskId && notionTaskExists && mapping.notionId) {
        await deleteNotionTaskPage(mapping.notionId);
        handledNotionIds.add(mapping.notionId);
        addLog(`Deleted task "${mapping.title}" from Notion (deleted from Google Tasks Pending)`, 'success');
        deletePendingMapping(mapping.id);
        continue;
      }

      // Deleted in Notion -> delete corresponding Google Task
      if (!notionTaskExists && mapping.notionId && gtaskExists && mapping.gtaskId) {
        await deleteGooglePendingTask(mapping.gtaskId);
        handledGTaskIds.add(mapping.gtaskId);
        addLog(`Deleted task "${mapping.title}" from Google Tasks Pending (deleted from Notion)`, 'success');
        deletePendingMapping(mapping.id);
        continue;
      }
    }

    // =========================================================================
    // 3. PASS B: COMPLETION & STATUS PROPAGATION (2-WAY TICK SYNC)
    // =========================================================================
    // Re-read mappings after deletion pass
    const currentMappings = getPendingMappings();

    for (const mapping of currentMappings) {
      const cleanTitleKey = mapping.title.trim().toLowerCase().replace(/\s+/g, ' ');

      const currentNotionTask =
        (mapping.notionId ? datelessNotionTasks.find((t) => t.id === mapping.notionId) : undefined) ||
        datelessNotionByTitle.get(cleanTitleKey);

      const gtaskItem =
        (mapping.gtaskId ? pendingGTasks.find((t) => t.id === mapping.gtaskId) : undefined) ||
        pendingGTasksByTitle.get(cleanTitleKey);

      if (!currentNotionTask || !gtaskItem) continue;

      const notionCompleted = Boolean(currentNotionTask.isCompleted);
      const gtaskCompleted = gtaskItem.status === 'completed';

      // CASE 1: Marked completed in Google Tasks, but Notion task is still uncompleted
      if (gtaskCompleted && !notionCompleted) {
        await updateNotionTask(currentNotionTask.id, { isCompleted: true });
        handledNotionIds.add(currentNotionTask.id);
        addLog(`Ticked task "${mapping.title}" in Notion (marked complete in Google Tasks Pending)`, 'success');
        mapping.isCompleted = true;
        upsertPendingMapping(mapping);
        continue;
      }

      // CASE 2: Checked/ticked in Notion, but Google Task is still uncompleted ('needsAction')
      if (notionCompleted && !gtaskCompleted) {
        await updateGooglePendingTask(gtaskItem.id, { isCompleted: true });
        handledGTaskIds.add(gtaskItem.id);
        addLog(`Ticked task "${mapping.title}" in Google Tasks Pending (checked in Notion)`, 'success');
        mapping.isCompleted = true;
        upsertPendingMapping(mapping);
        continue;
      }

      // CASE 3: Uncompleted in Google Tasks ('needsAction'), but Notion was marked complete previously (uncheck sync)
      if (!gtaskCompleted && notionCompleted && mapping.isCompleted) {
        await updateNotionTask(currentNotionTask.id, { isCompleted: false });
        handledNotionIds.add(currentNotionTask.id);
        addLog(`Unchecked task "${mapping.title}" in Notion (reopened in Google Tasks Pending)`, 'info');
        mapping.isCompleted = false;
        upsertPendingMapping(mapping);
        continue;
      }

      // CASE 4: Uncompleted in Notion (unchecked), but Google Task was completed previously (uncheck sync)
      if (!notionCompleted && gtaskCompleted && mapping.isCompleted) {
        await updateGooglePendingTask(gtaskItem.id, { isCompleted: false });
        handledGTaskIds.add(gtaskItem.id);
        addLog(`Unchecked task "${mapping.title}" in Google Tasks Pending (reopened in Notion)`, 'info');
        mapping.isCompleted = false;
        upsertPendingMapping(mapping);
        continue;
      }
    }

    // =========================================================================
    // 4. PASS C: CREATION SYNC FROM GOOGLE TASKS (PENDING) -> NOTION
    // Active tasks in Google Tasks "Pending" list get created in Notion without a date
    // =========================================================================
    for (const gtask of activePendingGTasks) {
      if (gtask.status === 'completed' || handledGTaskIds.has(gtask.id)) continue;
      const cleanTitleKey = gtask.title.trim().toLowerCase().replace(/\s+/g, ' ');

      let mapping = findPendingMappingByGTaskId(gtask.id) || findPendingMappingByTitle(gtask.title);
      const existingNotion = datelessNotionByTitle.get(cleanTitleKey);

      let notionId = mapping?.notionId;
      if (!notionId) {
        if (existingNotion) {
          notionId = existingNotion.id;
          if (existingNotion.isCompleted) {
            // If existing Notion task is already completed, propagate to Google Task
            await updateGooglePendingTask(gtask.id, { isCompleted: true });
          }
        } else {
          // Create task in Notion database with NO date and unchecked
          notionId = (await createNotionTask(gtask.title, undefined, false, gtask.notes)) || undefined;
          if (notionId) {
            addLog(`Created dateless task "${gtask.title}" in Notion from Google Tasks Pending`, 'success');
          }
        }
      } else if (mapping && gtask.notes && mapping.description !== gtask.notes) {
        await updateNotionTask(notionId, { notes: gtask.notes, title: gtask.title });
        addLog(`Updated notes for dateless task "${gtask.title}" in Notion`, 'info');
      }

      upsertPendingMapping({
        id: mapping?.id || gtask.id,
        notionId,
        gtaskId: gtask.id,
        title: gtask.title,
        description: gtask.notes,
        isCompleted: false,
        lastUpdated: new Date().toISOString(),
        sourcePlatform: 'gtask',
      });
    }

    // =========================================================================
    // 5. PASS D: CREATION SYNC FROM NOTION (UNCHECKED & NO DATE) -> GOOGLE TASKS (PENDING)
    // Unchecked tasks in Notion without a date get created in Google Tasks "Pending" list
    // =========================================================================
    for (const nTask of activeDatelessNotionTasks) {
      if (handledNotionIds.has(nTask.id)) continue;
      const cleanTitleKey = nTask.title.trim().toLowerCase().replace(/\s+/g, ' ');

      let mapping = findPendingMappingByNotionId(nTask.id) || findPendingMappingByTitle(nTask.title);
      const existingGTask = pendingGTasksByTitle.get(cleanTitleKey);

      let gtaskId = mapping?.gtaskId;
      if (!gtaskId) {
        if (existingGTask) {
          gtaskId = existingGTask.id;
          if (existingGTask.status === 'completed') {
            await updateNotionTask(nTask.id, { isCompleted: true });
          }
        } else {
          // Create task in Google Tasks "Pending" list
          gtaskId = (await createGooglePendingTask(nTask.title, nTask.notes, false)) || undefined;
          if (gtaskId) {
            addLog(`Created task "${nTask.title}" in Google Tasks Pending from Notion`, 'success');
          }
        }
      } else if (mapping && nTask.notes && mapping.description !== nTask.notes) {
        await updateGooglePendingTask(gtaskId, { notes: nTask.notes, title: nTask.title });
        addLog(`Updated notes for task "${nTask.title}" in Google Tasks Pending`, 'info');
      }

      upsertPendingMapping({
        id: mapping?.id || nTask.id,
        notionId: nTask.id,
        gtaskId,
        title: nTask.title,
        description: nTask.notes,
        isCompleted: false,
        lastUpdated: new Date().toISOString(),
        sourcePlatform: 'notion',
      });
    }
  } catch (error: any) {
    addLog(`Error during Pending sync execution: ${error?.message || error}`, 'error');
  }

  return logs;
}
