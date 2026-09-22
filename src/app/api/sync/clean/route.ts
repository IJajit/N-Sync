import { NextResponse } from 'next/server';
import { runCleanSync } from '@/lib/cleanSync';
import { getMappings } from '@/lib/syncStore';
import { getPendingMappings } from '@/lib/pendingSyncStore';
import { SyncLock } from '@/lib/syncLock';

export const dynamic = 'force-dynamic';

export async function POST() {
  const result = await SyncLock.runWithLock('CleanSync', async () => {
    const logs = await runCleanSync();
    const mappings = getMappings();
    const pendingMappings = getPendingMappings();
    return { logs, mappings, pendingMappings };
  });

  if (!result) {
    return NextResponse.json({
      success: true,
      skipped: true,
      logs: [],
      mappings: getMappings(),
      pendingMappings: getPendingMappings(),
    });
  }

  return NextResponse.json({
    success: true,
    logs: result.logs,
    mappings: result.mappings,
    pendingMappings: result.pendingMappings,
  });
}

export async function GET() {
  const mappings = getMappings();
  const pendingMappings = getPendingMappings();
  return NextResponse.json({ success: true, mappings, pendingMappings });
}
