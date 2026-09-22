import { NextResponse } from 'next/server';
import { runTwoWaySync } from '@/lib/syncEngine';
import { getMappings } from '@/lib/syncStore';
import { SyncLock } from '@/lib/syncLock';

export const dynamic = 'force-dynamic';

export async function POST() {
  const result = await SyncLock.runWithLock('TwoWaySync', async () => {
    const logs = await runTwoWaySync();
    const mappings = getMappings();
    return { logs, mappings };
  });

  if (!result) {
    return NextResponse.json({ success: true, skipped: true, logs: [], mappings: getMappings() });
  }

  return NextResponse.json({ success: true, logs: result.logs, mappings: result.mappings });
}

export async function GET() {
  const result = await SyncLock.runWithLock('TwoWaySync', async () => {
    const logs = await runTwoWaySync();
    const mappings = getMappings();
    return { logs, mappings };
  });

  if (!result) {
    return NextResponse.json({ success: true, skipped: true, logs: [], mappings: getMappings() });
  }

  return NextResponse.json({ success: true, logs: result.logs, mappings: result.mappings });
}
