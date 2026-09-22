import { NextResponse } from 'next/server';
import { runPendingSync } from '@/lib/pendingSyncEngine';
import { getPendingMappings } from '@/lib/pendingSyncStore';
import { fetchGooglePendingTasks } from '@/lib/googlePendingTasks';
import { SyncLock } from '@/lib/syncLock';

export const dynamic = 'force-dynamic';

export async function POST() {
  const result = await SyncLock.runWithLock('PendingSync', async () => {
    const logs = await runPendingSync();
    const mappings = getPendingMappings();
    const tasks = await fetchGooglePendingTasks();
    return { logs, mappings, tasks };
  });

  if (!result) {
    return NextResponse.json({
      success: true,
      skipped: true,
      logs: [],
      mappings: getPendingMappings(),
      tasks: await fetchGooglePendingTasks(),
    });
  }

  return NextResponse.json({ success: true, logs: result.logs, mappings: result.mappings, tasks: result.tasks });
}

export async function GET() {
  const mappings = getPendingMappings();
  const tasks = await fetchGooglePendingTasks();
  return NextResponse.json({ success: true, mappings, tasks });
}
