import fs from 'fs';
import path from 'path';
import os from 'os';

export interface PendingTaskMapping {
  id: string; // Internal UUID or Notion ID
  notionId?: string;
  gtaskId?: string;
  title: string;
  description?: string;
  isCompleted: boolean;
  lastUpdated: string; // ISO String
  sourcePlatform: 'notion' | 'gtask';
}

const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NODE_ENV === 'production');

function getDbFilePath(): string {
  if (isServerless) {
    return path.join(os.tmpdir(), 'pending_sync_data.json');
  }
  // If local, prefer cwd file if exists, or tmp if cwd doesn't exist
  const cwdPath = path.join(process.cwd(), 'pending_sync_data.json');
  const tmpPath = path.join(os.tmpdir(), 'pending_sync_data.json');
  if (fs.existsSync(cwdPath)) return cwdPath;
  if (fs.existsSync(tmpPath)) return tmpPath;
  return cwdPath;
}

export function getPendingMappings(): PendingTaskMapping[] {
  const filePath = getDbFilePath();
  try {
    if (!fs.existsSync(filePath)) {
      try {
        fs.writeFileSync(filePath, JSON.stringify([]));
      } catch (e) {
        // Read-only filesystem fallback
      }
      return [];
    }
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading pending sync mappings:', error);
    return [];
  }
}

export function savePendingMappings(mappings: PendingTaskMapping[]): void {
  const filePath = getDbFilePath();
  try {
    fs.writeFileSync(filePath, JSON.stringify(mappings, null, 2));
    // If not serverless, also mirror to tmpdir so both paths stay in sync
    if (!isServerless) {
      try {
        const tmpPath = path.join(os.tmpdir(), 'pending_sync_data.json');
        fs.writeFileSync(tmpPath, JSON.stringify(mappings, null, 2));
      } catch (e) {}
    }
  } catch (error) {
    console.error('Error saving pending sync mappings:', error);
  }
}

export function findPendingMappingByNotionId(notionId: string): PendingTaskMapping | undefined {
  const mappings = getPendingMappings();
  return mappings.find((m) => m.notionId === notionId);
}

export function findPendingMappingByGTaskId(gtaskId: string): PendingTaskMapping | undefined {
  const mappings = getPendingMappings();
  return mappings.find((m) => m.gtaskId === gtaskId);
}

export function findPendingMappingByTitle(title: string): PendingTaskMapping | undefined {
  const mappings = getPendingMappings();
  const normalized = title.trim().toLowerCase();
  return mappings.find((m) => m.title.trim().toLowerCase() === normalized);
}

export function upsertPendingMapping(mapping: PendingTaskMapping): void {
  const mappings = getPendingMappings();
  const normalizedTitle = mapping.title.trim().toLowerCase();

  const index = mappings.findIndex(
    (m) =>
      (mapping.notionId && m.notionId === mapping.notionId) ||
      (mapping.gtaskId && m.gtaskId === mapping.gtaskId) ||
      (m.title && m.title.trim().toLowerCase() === normalizedTitle)
  );

  if (index >= 0) {
    mappings[index] = { ...mappings[index], ...mapping, lastUpdated: new Date().toISOString() };
  } else {
    mappings.push({ ...mapping, lastUpdated: new Date().toISOString() });
  }
  savePendingMappings(mappings);
}

export function deletePendingMapping(idOrNotionId: string): void {
  const mappings = getPendingMappings();
  const filtered = mappings.filter((m) => m.id !== idOrNotionId && m.notionId !== idOrNotionId && m.gtaskId !== idOrNotionId);
  if (filtered.length !== mappings.length) {
    savePendingMappings(filtered);
  }
}
