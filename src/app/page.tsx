'use client';

import React, { useState, useEffect } from 'react';
import { RefreshCw, ExternalLink, Zap, Calendar as CalendarIcon, Database, ArrowUpRight, CheckCircle2 } from 'lucide-react';

export default function SyncDashboard() {
  const [syncing, setSyncing] = useState(false);
  const [logs, setLogs] = useState<any[]>([]);
  const [mappings, setMappings] = useState<any[]>([]);
  const [autoSync, setAutoSync] = useState(true);
  const [lastSyncedTime, setLastSyncedTime] = useState<string | null>(null);

  const triggerSync = async () => {
    setSyncing(true);
    try {
      const res = await fetch('/api/sync', { method: 'POST' });
      const data = await res.json();
      if (data.logs) {
        setLogs((prev) => [...data.logs, ...prev]);
      }
      if (data.mappings) {
        setMappings(data.mappings);
      }
      setLastSyncedTime(new Date().toLocaleTimeString());
    } catch (err) {
      console.error('Error triggering sync:', err);
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    fetch('/api/sync')
      .then((res) => res.json())
      .then((data) => {
        if (data.mappings) setMappings(data.mappings);
      });
  }, []);

  useEffect(() => {
    let interval: any = null;
    if (autoSync) {
      interval = setInterval(() => {
        triggerSync();
      }, 15000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [autoSync]);

  // Filter pending items only (exclude completed tasks)
  const pendingGCalItems = mappings.filter((m) => m.gcalId && !m.isCompleted);
  const pendingNotionItems = mappings.filter((m) => !m.isCompleted);

  return (
    <main className="min-h-screen bg-[#080808] text-[#f4f4f5] font-sans selection:bg-white selection:text-black p-4 sm:p-6 lg:p-8 flex flex-col justify-between">
      {/* Background ambient grain overlay */}
      <div 
        className="fixed inset-0 pointer-events-none opacity-[0.03] mix-blend-overlay"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E")`
        }}
      />

      <div className="max-w-[1600px] w-full mx-auto relative z-10 space-y-6">
        
        {/* Compact Header & Controls Bar */}
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-neutral-900 pb-5">
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-neutral-100 font-sans">
            Calendar Sync
          </h1>

          {/* Action Bar & High Visibility Toggle */}
          <div className="flex flex-wrap items-center gap-4 sm:gap-6 bg-[#0e0e10] border border-neutral-800 px-4 py-2.5">
            <label className="flex items-center gap-3 cursor-pointer select-none group">
              <div className="relative inline-flex items-center">
                <input
                  type="checkbox"
                  checked={autoSync}
                  onChange={(e) => setAutoSync(e.target.checked)}
                  className="sr-only peer"
                />
                {/* Switch Track with High Contrast Emerald State */}
                <div className="w-12 h-6 bg-neutral-800 border border-neutral-700 rounded-full peer peer-checked:bg-emerald-500 peer-checked:border-emerald-400 transition-colors"></div>
                {/* Switch Knob */}
                <div className="absolute left-[3px] top-[3px] w-4 h-4 bg-white rounded-full transition-transform peer-checked:translate-x-6"></div>
              </div>
              <span className="text-xs font-mono tracking-wider font-medium text-neutral-300 group-hover:text-white">
                Live auto sync (15s)
              </span>
            </label>

            <span className="hidden sm:inline text-neutral-800 font-mono">|</span>

            <span className="text-[11px] font-mono text-neutral-400">
              {lastSyncedTime ? `Last sync: ${lastSyncedTime}` : 'Ready'}
            </span>

            <button
              onClick={triggerSync}
              disabled={syncing}
              className="inline-flex items-center justify-center gap-2 bg-white hover:bg-neutral-200 disabled:opacity-50 text-black font-semibold text-xs tracking-wide px-5 py-2 transition-all cursor-pointer active:scale-95 ml-auto sm:ml-0"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? 'Syncing...' : 'Sync now'}
            </button>
          </div>
        </header>

        {/* 3 Vertical Equal-Height Columns */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-stretch">
          
          {/* COLUMN 1: GOOGLE CALENDAR */}
          <section className="bg-[#0b0b0d] border border-neutral-850 p-5 flex flex-col justify-between space-y-5">
            <div className="space-y-4">
              {/* Header in Sentence case */}
              <div className="border-b border-neutral-800 pb-3 flex items-baseline justify-between">
                <h2 className="text-base font-semibold tracking-tight text-neutral-200">
                  Google Calendar
                </h2>
                <span className="text-[10px] font-mono text-neutral-500">Events</span>
              </div>

              {/* Action Buttons at Top */}
              <div className="grid grid-cols-1 gap-2.5">
                <a
                  href="/api/auth/google/login"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center justify-between p-3 bg-[#111114] border border-neutral-800 hover:border-neutral-600 transition-all text-xs font-mono text-neutral-300 hover:text-white group/link"
                >
                  <span className="flex items-center gap-2">
                    <Zap className="w-3.5 h-3.5 text-emerald-400" />
                    Connect Google account
                  </span>
                  <ArrowUpRight className="w-3.5 h-3.5 text-neutral-500 group-hover/link:text-white group-hover/link:translate-x-0.5 group-hover/link:-translate-y-0.5 transition-transform" />
                </a>

                <a
                  href="https://calendar.google.com"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center justify-between p-3 bg-[#111114] border border-neutral-800 hover:border-neutral-600 transition-all text-xs font-mono text-neutral-300 hover:text-white group/link"
                >
                  <span className="flex items-center gap-2">
                    <CalendarIcon className="w-3.5 h-3.5 text-neutral-400" />
                    Open Google Calendar
                  </span>
                  <ExternalLink className="w-3.5 h-3.5 text-neutral-500 group-hover/link:text-white group-hover/link:translate-x-0.5 group-hover/link:-translate-y-0.5 transition-transform" />
                </a>
              </div>

              {/* Live Calendar Feed (Pending Only) */}
              <div className="space-y-3 pt-2">
                <div className="text-[10px] font-mono tracking-widest text-neutral-500 border-b border-neutral-900 pb-1.5 flex justify-between">
                  <span>Live calendar feed</span>
                  <span>{pendingGCalItems.length} Pending</span>
                </div>

                <div className="space-y-2.5 max-h-[360px] overflow-y-auto pr-1">
                  {pendingGCalItems.length === 0 ? (
                    <div className="py-12 text-center text-xs font-mono text-neutral-600 border border-dashed border-neutral-900">
                      No pending calendar events found.
                    </div>
                  ) : (
                    pendingGCalItems.map((item) => (
                      <div key={item.id} className="flex items-center justify-between border-b border-neutral-900 pb-2 text-xs font-mono">
                        <div className="flex items-center gap-2.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                          <span className="text-neutral-300 truncate max-w-[200px]">{item.title}</span>
                        </div>
                        <span className="text-[9px] text-neutral-500 font-mono">
                          {item.dueDate ? item.dueDate : 'Pending'}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            <div className="pt-3 border-t border-neutral-900 flex justify-between text-[10px] font-mono text-neutral-500">
              <span>Protocol: GCal V3</span>
              <span>Status: Active</span>
            </div>
          </section>


          {/* COLUMN 2: NOTION DATABASE */}
          <section className="bg-[#0b0b0d] border border-neutral-850 p-5 flex flex-col justify-between space-y-5">
            <div className="space-y-4">
              {/* Header in Sentence case */}
              <div className="border-b border-neutral-800 pb-3 flex items-baseline justify-between">
                <h2 className="text-base font-semibold tracking-tight text-neutral-200">
                  Notion Database
                </h2>
                <span className="text-[10px] font-mono text-neutral-500">Tasks</span>
              </div>

              {/* Action Buttons at Top */}
              <div className="grid grid-cols-1 gap-2.5">
                <a
                  href="https://www.notion.so/my-integrations"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center justify-between p-3 bg-[#111114] border border-neutral-800 hover:border-neutral-600 transition-all text-xs font-mono text-neutral-300 hover:text-white group/link"
                >
                  <span className="flex items-center gap-2">
                    <Database className="w-3.5 h-3.5 text-emerald-400" />
                    Connect Notion DB
                  </span>
                  <ArrowUpRight className="w-3.5 h-3.5 text-neutral-500 group-hover/link:text-white group-hover/link:translate-x-0.5 group-hover/link:-translate-y-0.5 transition-transform" />
                </a>

                <a
                  href="https://notion.so"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center justify-between p-3 bg-[#111114] border border-neutral-800 hover:border-neutral-600 transition-all text-xs font-mono text-neutral-300 hover:text-white group/link"
                >
                  <span className="flex items-center gap-2">
                    <ExternalLink className="w-3.5 h-3.5 text-neutral-400" />
                    Open Notion
                  </span>
                  <ExternalLink className="w-3.5 h-3.5 text-neutral-500 group-hover/link:text-white group-hover/link:translate-x-0.5 group-hover/link:-translate-y-0.5 transition-transform" />
                </a>
              </div>

              {/* Synced Notion Tasks Feed (Pending Only) */}
              <div className="space-y-3 pt-2">
                <div className="text-[10px] font-mono tracking-widest text-neutral-500 border-b border-neutral-900 pb-1.5 flex justify-between">
                  <span>Pending database items</span>
                  <span>{pendingNotionItems.length} Pending</span>
                </div>

                <div className="space-y-2.5 max-h-[360px] overflow-y-auto pr-1">
                  {pendingNotionItems.length === 0 ? (
                    <div className="py-12 text-center text-xs font-mono text-neutral-600 border border-dashed border-neutral-900">
                      No pending tasks found. All tasks are completed.
                    </div>
                  ) : (
                    pendingNotionItems.map((item) => (
                      <div key={item.id} className="flex items-center justify-between border-b border-neutral-900 pb-2 text-xs font-mono">
                        <div className="flex items-center gap-2.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
                          <span className="text-neutral-300 truncate max-w-[190px]">{item.title}</span>
                        </div>
                        <span className="text-[9px] px-1.5 py-0.5 border border-amber-900/60 text-amber-400 bg-amber-950/30">
                          Pending
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            <div className="pt-3 border-t border-neutral-900 flex justify-between text-[10px] font-mono text-neutral-500">
              <span>DB ID: 368e...212f</span>
              <span>Status: Connected</span>
            </div>
          </section>


          {/* COLUMN 3: LIVE SYNC ACTIVITY */}
          <section className="bg-[#0b0b0d] border border-neutral-850 p-5 flex flex-col justify-between space-y-5">
            <div className="space-y-4">
              {/* Header in Sentence case */}
              <div className="border-b border-neutral-800 pb-3 flex items-baseline justify-between">
                <h2 className="text-base font-semibold tracking-tight text-neutral-200">
                  Live Sync Activity
                </h2>
                <span className="text-[10px] font-mono text-neutral-500">Terminal</span>
              </div>

              {/* Status Header */}
              <div className="p-3 bg-[#111114] border border-neutral-800 text-xs font-mono flex items-center justify-between text-neutral-300">
                <span className="flex items-center gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                  Realtime log stream
                </span>
                <span className="text-[10px] text-neutral-500">{logs.length} Logs</span>
              </div>

              {/* Terminal Logs Below */}
              <div className="space-y-3 pt-2">
                <div className="text-[10px] font-mono tracking-widest text-neutral-500 border-b border-neutral-900 pb-1.5 flex justify-between">
                  <span>Activity stream</span>
                  <span>Live</span>
                </div>

                <div className="font-mono text-xs max-h-[360px] overflow-y-auto space-y-2 text-neutral-400 pr-1">
                  {logs.length === 0 ? (
                    <div className="text-neutral-600 italic py-12 text-center border border-dashed border-neutral-900">
                      Waiting for activity... Click &quot;Sync now&quot; to trigger manual sync.
                    </div>
                  ) : (
                    logs.map((log, index) => (
                      <div key={index} className="flex items-start gap-2 border-b border-neutral-950 pb-1.5 text-[11px]">
                        <span className="text-neutral-600 shrink-0">[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                        <span className={
                          log.type === 'success' ? 'text-emerald-400' :
                          log.type === 'error' ? 'text-rose-400' :
                          log.type === 'warning' ? 'text-amber-400' : 'text-neutral-300'
                        }>
                          {log.message}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            <div className="pt-3 border-t border-neutral-900 flex justify-between text-[10px] font-mono text-neutral-500">
              <span>System: OK</span>
              <span>Engine: Active</span>
            </div>
          </section>

        </div>

        {/* Compact Footer in Sentence case */}
        <footer className="pt-4 border-t border-neutral-900 flex items-center justify-between text-[11px] font-mono text-neutral-600">
          <span className="tracking-widest text-neutral-500">Calendar Sync &copy; 2026</span>
          <span className="text-neutral-600">Notion & Google 2-Way Engine</span>
        </footer>

      </div>
    </main>
  );
}




