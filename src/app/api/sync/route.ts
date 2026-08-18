import { NextResponse } from 'next/server';
import { runTwoWaySync } from '@/lib/syncEngine';
import { getMappings } from '@/lib/syncStore';

export async function POST() {
  const logs = await runTwoWaySync();
  const mappings = getMappings();
  return NextResponse.json({ success: true, logs, mappings });
}

export async function GET() {
  const mappings = getMappings();
  return NextResponse.json({ mappings });
}
