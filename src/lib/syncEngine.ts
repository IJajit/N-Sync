import { fetchNotionTasks, updateNotionTask, createNotionTask, deleteNotionTaskPage, verifyNotionPageArchived } from './notion';
import { fetchGoogleCalendarEvents, createGoogleCalendarEvent, updateGoogleCalendarEvent, deleteGoogleCalendarEvent, GCalEventItem } from './google';
import { getMappings, upsertMapping, findMappingByNotionId, findMappingByGCalId, findMappingByTitle } from './syncStore';

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
    // 1. Fetch data from Notion Tasks and Google Calendar
    const [allNotionTasks, gcalEvents] = await Promise.all([
      fetchNotionTasks(),
      fetchGoogleCalendarEvents(),
    ]);

    const activeGCalEvents = gcalEvents.filter((e) => !e.isCancelled);
    const uncheckedNotionTasks = allNotionTasks.filter((t) => !t.isCompleted);
    const gcalEventIds = new Set(activeGCalEvents.map((e) => e.id));
    const notionTaskIds = new Set(allNotionTasks.map((t) => t.id));
    const allMappings = getMappings();

    const buildDescription = (notes?: string, url?: string, notionPageUrl?: string) => {
      const parts: string[] = [];
      if (notes) parts.push(`Notes:\n${notes}`);
      if (url) parts.push(`Website: ${url}`);
      if (notionPageUrl) parts.push(`Notion Task: ${notionPageUrl}`);
      return parts.length > 0 ? parts.join('\n\n') : undefined;
    };

    // =========================================================================
    // 1.5 AUTOMATED GOOGLE CALENDAR DEDUPLICATION PASS
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

    // =========================================================================
    // 2. SAFE BI-DIRECTIONAL DELETION & CONFLICT RESOLUTION
    // =========================================================================
    const deletedNotionIds = new Set<string>();
    const deletedGCalIds = new Set<string>();

    for (const mapping of [...allMappings]) {
      const notionTaskExists = mapping.notionId ? notionTaskIds.has(mapping.notionId) : false;
      const currentNotionTask = mapping.notionId ? allNotionTasks.find((t) => t.id === mapping.notionId) : undefined;
      const notionTaskCompleted = currentNotionTask ? currentNotionTask.isCompleted : false;
      const gcalEvt = mapping.gcalId ? gcalEvents.find((e) => e.id === mapping.gcalId) : undefined;
      const isExplicitlyCancelledInGCal = gcalEvt ? Boolean(gcalEvt.isCancelled) : false;

      // Case A: Task completed in Notion (or page archived/deleted in Notion manually) -> Remove from Google Calendar
      if (mapping.notionId && (!notionTaskExists || notionTaskCompleted)) {
        if (!mapping.isCompleted || (mapping.gcalId && gcalEventIds.has(mapping.gcalId))) {
          const isNotionPageArchived = !notionTaskExists ? await verifyNotionPageArchived(mapping.notionId) : false;

          if (isNotionPageArchived || notionTaskCompleted) {
            if (mapping.gcalId && gcalEventIds.has(mapping.gcalId)) {
              await deleteGoogleCalendarEvent(mapping.gcalId);
              addLog(`Removed event "${mapping.title}" from Google Calendar (task checked/completed in Notion)`, 'success');
            }
            if (mapping.notionId) deletedNotionIds.add(mapping.notionId);
            if (mapping.gcalId) deletedGCalIds.add(mapping.gcalId);

            mapping.isCompleted = true;
            mapping.gcalId = undefined;
            upsertMapping(mapping);
            continue;
          }
        }
      }

      // Case B: Event deleted/cancelled in Google Calendar -> Mark Notion task as CHECKED (Do NOT archive Notion page!)
      if (mapping.gcalId && isExplicitlyCancelledInGCal && !mapping.isCompleted) {
        if (mapping.notionId && notionTaskExists) {
          await updateNotionTask(mapping.notionId, { isCompleted: true });
          addLog(`Checked task "${mapping.title}" in Notion (deleted from Google Calendar)`, 'success');
        }
        if (mapping.notionId) deletedNotionIds.add(mapping.notionId);
        if (mapping.gcalId) deletedGCalIds.add(mapping.gcalId);

        mapping.isCompleted = true;
        mapping.gcalId = undefined;
        upsertMapping(mapping);
        continue;
      }
    }

    // =========================================================================
    // 3. NOTION TASKS -> GOOGLE CALENDAR (Strict Single Creation Per Title & Resync Unchecked)
    // =========================================================================
    const createdGCalTitlesInRun = new Set<string>();
    const modifiedInRun = new Set<string>();

    for (const nTask of allNotionTasks) {
      const normalizedTitle = nTask.title.trim().toLowerCase();
      const cleanTitleKey = normalizedTitle.replace(/\s+/g, ' ');

      if (deletedNotionIds.has(nTask.id)) {
        continue;
      }

      let mapping = findMappingByNotionId(nTask.id) || findMappingByTitle(nTask.title);
      const descriptionText = buildDescription(nTask.notes, nTask.url, nTask.notionPageUrl);

      // Handle Resync if user UNCHECKED a task in Notion
      if (mapping && mapping.isCompleted && !nTask.isCompleted) {
        mapping.isCompleted = false;
        const gcalId = await createGoogleCalendarEvent(nTask.title, nTask.dueDate, descriptionText);
        if (gcalId) {
          mapping.gcalId = gcalId;
          mapping.dueDate = nTask.dueDate;
          mapping.description = descriptionText;
          mapping.lastUpdated = new Date().toISOString();
          upsertMapping(mapping);
          addLog(`Resynced unchecked task "${nTask.title}" back to Google Calendar!`, 'success');
        }
        continue;
      }

      if (nTask.isCompleted) {
        continue;
      }

      if (mapping && !mapping.isCompleted) {
        createdGCalTitlesInRun.add(cleanTitleKey);
        const titleChanged = nTask.title !== mapping.title;
        const dateChanged = nTask.dueDate !== mapping.dueDate;
        const descriptionChanged = descriptionText !== mapping.description;

        if (titleChanged || dateChanged || descriptionChanged) {
          modifiedInRun.add(mapping.id);
          if (mapping.notionId) modifiedInRun.add(mapping.notionId);
          if (mapping.gcalId) modifiedInRun.add(mapping.gcalId);

          if (mapping.gcalId) {
            await updateGoogleCalendarEvent(mapping.gcalId, {
              title: nTask.title,
              dueDate: nTask.dueDate,
              description: descriptionText,
            });
          }

          mapping.title = nTask.title;
          mapping.dueDate = nTask.dueDate;
          mapping.description = descriptionText;
          mapping.notionId = nTask.id;
          mapping.lastUpdated = new Date().toISOString();
          upsertMapping(mapping);
          addLog(`Updated Google Calendar event details for Notion task "${nTask.title}"`, 'success');
        } else if (!mapping.notionId) {
          mapping.notionId = nTask.id;
          mapping.description = descriptionText;
          upsertMapping(mapping);
        }
      } else if (!mapping) {
        const existingGCalEvent = gcalEvents.find(
          (evt) => evt.summary.trim().toLowerCase().replace(/\s+/g, ' ') === cleanTitleKey && !evt.isCancelled
        );

        if (existingGCalEvent) {
          createdGCalTitlesInRun.add(cleanTitleKey);
          upsertMapping({
            id: nTask.id,
            notionId: nTask.id,
            gcalId: existingGCalEvent.id,
            title: nTask.title,
            dueDate: nTask.dueDate,
            description: descriptionText,
            isCompleted: false,
            lastUpdated: new Date().toISOString(),
            sourcePlatform: 'notion',
          });
        } else {
          if (createdGCalTitlesInRun.has(cleanTitleKey)) {
            continue;
          }

          const gcalId = await createGoogleCalendarEvent(nTask.title, nTask.dueDate, descriptionText);
          if (gcalId) {
            createdGCalTitlesInRun.add(cleanTitleKey);
            upsertMapping({
              id: nTask.id,
              notionId: nTask.id,
              gcalId: gcalId,
              title: nTask.title,
              dueDate: nTask.dueDate,
              description: descriptionText,
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
    // 4. GOOGLE CALENDAR -> NOTION TASKS (Creation & Modifications)
    // =========================================================================
    const createdNotionTitlesInRun = new Set<string>();

    for (const evt of activeGCalEvents) {
      const normalizedSummary = evt.summary.trim().toLowerCase().replace(/\s+/g, ' ');

      if (deletedGCalIds.has(evt.id)) {
        continue;
      }

      let mapping = findMappingByGCalId(evt.id) || findMappingByTitle(evt.summary);

      if (mapping && mapping.isCompleted) {
        continue;
      }

      if (mapping && (modifiedInRun.has(mapping.id) || (mapping.notionId && modifiedInRun.has(mapping.notionId)) || (mapping.gcalId && modifiedInRun.has(mapping.gcalId)))) {
        continue; // Skip items modified in Step 3 to prevent reversion!
      }

      if (mapping && !mapping.isCompleted) {
        createdNotionTitlesInRun.add(normalizedSummary);
        const titleChanged = evt.summary !== mapping.title;
        const dateChanged = evt.start !== mapping.dueDate;
        const descriptionChanged = evt.description !== undefined && evt.description !== mapping.description;

        if (titleChanged || dateChanged || descriptionChanged) {
          if (mapping.notionId) {
            await updateNotionTask(mapping.notionId, {
              title: evt.summary,
              dueDate: evt.start,
              notes: evt.description,
            });
          }

          mapping.title = evt.summary;
          mapping.dueDate = evt.start;
          mapping.description = evt.description;
          mapping.gcalId = evt.id;
          mapping.lastUpdated = new Date().toISOString();
          upsertMapping(mapping);
          addLog(`Updated Notion task details for GCal event "${evt.summary}"`, 'success');
        } else if (!mapping.gcalId) {
          mapping.gcalId = evt.id;
          upsertMapping(mapping);
        }
      } else if (!mapping) {
        const existingNotionTask = allNotionTasks.find(
          (t) => t.title.trim().toLowerCase().replace(/\s+/g, ' ') === normalizedSummary
        );

        if (existingNotionTask) {
          createdNotionTitlesInRun.add(normalizedSummary);
          if (evt.description && evt.description !== existingNotionTask.notes) {
            await updateNotionTask(existingNotionTask.id, {
              notes: evt.description,
            });
          }
          upsertMapping({
            id: existingNotionTask.id,
            notionId: existingNotionTask.id,
            gcalId: evt.id,
            title: evt.summary,
            dueDate: evt.start,
            description: evt.description || existingNotionTask.notes,
            isCompleted: existingNotionTask.isCompleted,
            lastUpdated: new Date().toISOString(),
            sourcePlatform: 'gcal',
          });
        } else {
          if (createdNotionTitlesInRun.has(normalizedSummary)) {
            continue;
          }

          createdNotionTitlesInRun.add(normalizedSummary);

          const notionId = await createNotionTask(evt.summary, evt.start, false, evt.description);
          if (notionId) {
            allNotionTasks.push({
              id: notionId,
              title: evt.summary,
              isCompleted: false,
              dueDate: evt.start,
              notes: evt.description,
              lastEditedTime: new Date().toISOString(),
            });
            upsertMapping({
              id: notionId,
              notionId,
              gcalId: evt.id,
              title: evt.summary,
              dueDate: evt.start,
              description: evt.description,
              isCompleted: false,
              lastUpdated: new Date().toISOString(),
              sourcePlatform: 'gcal',
            });
            addLog(`Synced Google Calendar event "${evt.summary}" to Notion!`, 'success');
          }
        }
      }
    }
  } catch (error: any) {
    addLog(`Error during sync execution: ${error?.message || error}`, 'error');
  }

  return logs;
}
