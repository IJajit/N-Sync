import { NextResponse } from 'next/server';
import { runPendingSync } from '@/lib/pendingSyncEngine';
import { getPendingMappings } from '@/lib/pendingSyncStore';
import { fetchGooglePendingTasks } from '@/lib/googlePendingTasks';

export const dynamic = 'force-dynamic';

export async function POST() {
  const logs = await runPendingSync();
  const mappings = getPendingMappings();
  const tasks = await fetchGooglePendingTasks();
  return NextResponse.json({ success: true, logs, mappings, tasks });
}

export async function GET() {
  const mappings = getPendingMappings();
  const tasks = await fetchGooglePendingTasks();
  return NextResponse.json({ success: true, mappings, tasks });
}
