import fs from 'fs';
import path from 'path';

export interface TaskMapping {
  id: string; // Internal UUID or Notion ID
  notionId?: string;
  gcalId?: string;
  gtaskId?: string;
  title: string;
  dueDate?: string; // ISO String
  isCompleted: boolean;
  lastUpdated: string; // ISO String
  sourcePlatform: 'notion' | 'gcal' | 'gtask';
}

const DB_FILE = path.join(process.cwd(), 'sync_data.json');

export function getMappings(): TaskMapping[] {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify([]));
      return [];
    }
    const data = fs.readFileSync(DB_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading sync mappings:', error);
    return [];
  }
}

export function saveMappings(mappings: TaskMapping[]): void {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(mappings, null, 2));
  } catch (error) {
    console.error('Error saving sync mappings:', error);
  }
}

export function findMappingByNotionId(notionId: string): TaskMapping | undefined {
  const mappings = getMappings();
  return mappings.find((m) => m.notionId === notionId);
}

export function findMappingByGCalId(gcalId: string): TaskMapping | undefined {
  const mappings = getMappings();
  return mappings.find((m) => m.gcalId === gcalId);
}

export function findMappingByGTaskId(gtaskId: string): TaskMapping | undefined {
  const mappings = getMappings();
  return mappings.find((m) => m.gtaskId === gtaskId);
}

export function findMappingByTitle(title: string): TaskMapping | undefined {
  const mappings = getMappings();
  const normalized = title.trim().toLowerCase();
  return mappings.find((m) => m.title.trim().toLowerCase() === normalized);
}

export function upsertMapping(mapping: TaskMapping): void {
  const mappings = getMappings();
  const normalizedTitle = mapping.title.trim().toLowerCase();

  const index = mappings.findIndex(
    (m) =>
      (mapping.notionId && m.notionId === mapping.notionId) ||
      (mapping.gcalId && m.gcalId === mapping.gcalId) ||
      (mapping.gtaskId && m.gtaskId === mapping.gtaskId) ||
      (m.title && m.title.trim().toLowerCase() === normalizedTitle)
  );

  if (index >= 0) {
    mappings[index] = { ...mappings[index], ...mapping, lastUpdated: new Date().toISOString() };
  } else {
    mappings.push({ ...mapping, lastUpdated: new Date().toISOString() });
  }
  saveMappings(mappings);
}
