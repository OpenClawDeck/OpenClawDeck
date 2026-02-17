
import React, { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import { Language } from '../types';
import { getTranslation } from '../locales';
import { gwApi } from '../services/api';
import CustomSelect from '../components/CustomSelect';

interface AlertsProps { language: Language; }

function fmtRemaining(ms: number) {
  const rem = Math.max(0, ms);
  const s = Math.floor(rem / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

function fmtRelative(ts?: number) {
  if (!ts) return '-';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '<1m ago';
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

interface PendingApproval {
  id: string;
  request: {
    command: string;
    cwd?: string | null;
    host?: string | null;
    security?: string | null;
    ask?: string | null;
    agentId?: string | null;
    resolvedPath?: string | null;
    sessionKey?: string | null;
  };
  createdAtMs: number;
  expiresAtMs: number;
}

const Alerts: React.FC<AlertsProps> = ({ language }) => {
  const t = useMemo(() => getTranslation(language), [language]);
  const a = (t as any).alrt as any;

  // WS connection (via Manager's own /api/ws)
  const wsRef = useRef<WebSocket | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [wsConnecting, setWsConnecting] = useState(false);
  const [wsError, setWsError] = useState<string | null>(null);

  const [tab, setTab] = useState<'pending' | 'policy' | 'notify' | 'allowlist'>('pending');
  const [snapshot, setSnapshot] = useState<any>(null);
  const [form, setForm] = useState<any>(null);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedScope, setSelectedScope] = useState('__defaults__');
  const [pendingQueue, setPendingQueue] = useState<PendingApproval[]>([]);
  const [, setTick] = useState(0);

  // Forwarding config (from Gateway config.yaml approvals.exec.*)
  const [fwdEnabled, setFwdEnabled] = useState(false);
  const [fwdMode, setFwdMode] = useState('session');
  const [fwdTargets, setFwdTargets] = useState<string[]>([]);
  const [fwdAgentFilter, setFwdAgentFilter] = useState('');
  const [fwdSessionFilter, setFwdSessionFilter] = useState('');
  const [fwdSaving, setFwdSaving] = useState(false);
  const [fwdNewTarget, setFwdNewTarget] = useState('');

  // Connect to Manager's /api/ws for real-time exec approval events
  // (Gateway events are forwarded by backend GWCollector → wsHub "gw_event" channel)
  useEffect(() => {
    setWsConnecting(true);
    setWsError(null);

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/api/v1/ws`);

    const connectTimeout = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        setWsConnecting(false);
        setWsError(a.wsError);
      }
    }, 12000);

    ws.onopen = () => {
      clearTimeout(connectTimeout);
      setWsConnected(true);
      setWsConnecting(false);
      setWsError(null);
      // Subscribe to gw_event channel to receive gateway-forwarded events
      ws.send(JSON.stringify({ action: 'subscribe', channels: ['gw_event'] }));
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'exec.approval.requested') {
          const p = msg.data as PendingApproval | undefined;
          if (p?.id) {
            setPendingQueue(q => {
              if (q.some(item => item.id === p.id)) return q;
              return [p, ...q];
            });
          }
        } else if (msg.type === 'exec.approval.resolved') {
          const p = msg.data as { id: string } | undefined;
          if (p?.id) {
            setPendingQueue(q => q.filter(item => item.id !== p.id));
          }
        }
      } catch { /* ignore */ }
    };

    ws.onclose = () => {
      clearTimeout(connectTimeout);
      setWsConnected(false);
      setWsConnecting(false);
    };

    wsRef.current = ws;
    return () => {
      clearTimeout(connectTimeout);
      ws.close();
      wsRef.current = null;
    };
  }, []);

  // Auto-expire timer: refresh pending queue display every second
  useEffect(() => {
    if (pendingQueue.length === 0) return;
    const timer = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(timer);
  }, [pendingQueue.length]);

  // Auto-remove expired items after 10s past expiry
  useEffect(() => {
    if (pendingQueue.length === 0) return;
    const now = Date.now();
    const expired = pendingQueue.filter(item => (item.expiresAtMs - now) < -10000);
    if (expired.length > 0) {
      setPendingQueue(q => q.filter(item => (item.expiresAtMs - now) >= -10000));
    }
  }, [pendingQueue]);

  const loadApprovals = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res: any = await gwApi.execApprovalsGet();
      setSnapshot(res);
      setForm(JSON.parse(JSON.stringify(res?.file || {})));
      setDirty(false);
    } catch (e: any) { setError(String(e)); }
    setLoading(false);
  }, []);

  // Load forwarding config from Gateway config.yaml
  const loadFwdConfig = useCallback(async () => {
    try {
      const res: any = await gwApi.configGet();
      const cfg = res?.parsed || res?.config || res;
      const exec = cfg?.approvals?.exec;
      if (exec) {
        setFwdEnabled(exec.enabled === true);
        setFwdMode(exec.mode || 'session');
        setFwdTargets(Array.isArray(exec.targets) ? exec.targets : []);
        setFwdAgentFilter(Array.isArray(exec.agentFilter) ? exec.agentFilter.join(', ') : (exec.agentFilter || ''));
        setFwdSessionFilter(Array.isArray(exec.sessionFilter) ? exec.sessionFilter.join(', ') : (exec.sessionFilter || ''));
      }
    } catch { /* gateway not connected, ignore */ }
  }, []);

  useEffect(() => { loadApprovals(); loadFwdConfig(); }, [loadApprovals, loadFwdConfig]);

  // Save a single forwarding config field via gwApi.configSet
  const saveFwdField = useCallback(async (key: string, value: any) => {
    setFwdSaving(true);
    try {
      await gwApi.configSet(`approvals.exec.${key}`, value);
    } catch { /* ignore */ }
    setFwdSaving(false);
  }, []);

  const patchForm = useCallback((path: string[], value: any) => {
    setForm((prev: any) => {
      if (!prev) return prev;
      const next = JSON.parse(JSON.stringify(prev));
      let obj = next;
      for (let i = 0; i < path.length - 1; i++) {
        if (obj[path[i]] == null) obj[path[i]] = typeof path[i + 1] === 'number' ? [] : {};
        obj = obj[path[i]];
      }
      obj[path[path.length - 1]] = value;
      setDirty(true);
      return next;
    });
  }, []);

  const removeFromForm = useCallback((path: string[]) => {
    setForm((prev: any) => {
      if (!prev) return prev;
      const next = JSON.parse(JSON.stringify(prev));
      let obj = next;
      for (let i = 0; i < path.length - 1; i++) {
        if (obj[path[i]] == null) return next;
        obj = obj[path[i]];
      }
      const last = path[path.length - 1];
      if (Array.isArray(obj)) obj.splice(Number(last), 1);
      else delete obj[last];
      setDirty(true);
      return next;
    });
  }, []);

  const saveApprovals = useCallback(async () => {
    if (saving || !snapshot?.hash || !form) return;
    setSaving(true); setError(null);
    try {
      await gwApi.execApprovalsSet(form, snapshot.hash);
      await loadApprovals();
    } catch (e: any) { setError(String(e)); }
    setSaving(false);
  }, [saving, snapshot, form, loadApprovals]);

  const handleDecision = useCallback(async (id: string, decision: string) => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      await gwApi.execApprovalDecision(id, decision);
      setPendingQueue(q => q.filter(item => item.id !== id));
    } catch (e: any) { setError(a.decideFailed + ': ' + String(e)); }
    setBusy(false);
  }, [busy, a.decideFailed]);

  const defaults = form?.defaults || {};
  const agents: Record<string, any> = form?.agents || {};
  const agentIds = Object.keys(agents);
  const isDefaults = selectedScope === '__defaults__';
  const scopeData = isDefaults ? defaults : (agents[selectedScope] || {});
  const allowlist: any[] = isDefaults ? [] : (scopeData.allowlist || []);

  return (
    <main className="flex-1 overflow-y-auto p-4 md:p-5 custom-scrollbar bg-slate-50/50 dark:bg-transparent">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-base font-bold dark:text-white/40 text-slate-800">{a.title}</h1>
          <p className="text-[11px] text-slate-400 dark:text-white/35 mt-0.5">{a.desc}</p>
        </div>
        <div className="flex items-center gap-2">
          {/* WS connection status */}
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/5">
            <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${wsConnected ? 'bg-mac-green animate-pulse' : wsConnecting ? 'bg-mac-yellow animate-pulse' : 'bg-slate-300 dark:bg-white/20'
              }`} />
            <span className="text-[11px] font-medium text-slate-500 dark:text-white/40 hidden sm:inline">
              {wsConnected ? a.wsLive : wsConnecting ? a.wsConnecting : a.wsDisconnected}
            </span>
          </div>
          {dirty && <span className="text-[11px] text-mac-yellow font-bold self-center">{a.unsaved}</span>}
          <button onClick={saveApprovals} disabled={saving || !dirty}
            className="px-3 py-1.5 rounded-lg bg-primary text-white text-[11px] font-bold disabled:opacity-40">{saving ? a.saving : a.save}</button>
          <button onClick={loadApprovals} disabled={loading} className="p-1.5 rounded-lg text-slate-400 hover:text-primary hover:bg-primary/5 transition-all disabled:opacity-40">
            <span className={`material-symbols-outlined text-[18px] ${loading ? 'animate-spin' : ''}`}>refresh</span>
          </button>
        </div>
      </div>

      {wsError && !wsConnected && !wsConnecting && (
        <div className="mb-3 px-3 py-2 rounded-xl bg-mac-yellow/10 border border-mac-yellow/20 text-[10px] text-mac-yellow flex items-center gap-2">
          <span className="material-symbols-outlined text-[14px]">warning</span>
          {wsError}
        </div>
      )}

      {error && <div className="mb-3 px-3 py-2 rounded-xl bg-mac-red/10 border border-mac-red/20 text-[10px] text-mac-red">{error}</div>}

      {/* Tabs */}
      <div className="flex gap-1 mb-4">
        {(['pending', 'policy', 'notify', 'allowlist'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all ${tab === t ? 'bg-primary text-white' : 'text-slate-500 dark:text-white/40 hover:bg-slate-100 dark:hover:bg-white/5'}`}>
            {a[t]}
            {t === 'pending' && pendingQueue.length > 0 && <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-mac-red text-white text-[10px]">{pendingQueue.length}</span>}
          </button>
        ))}
      </div>

      <div className="max-w-5xl space-y-4">
        {/* Pending Approval Queue */}
        {tab === 'pending' && (
          <div className="rounded-2xl border border-slate-200/60 dark:border-white/[0.06] bg-white dark:bg-white/[0.02] p-4">
            <h3 className="text-[11px] font-bold text-slate-600 dark:text-white/60 uppercase tracking-wider mb-3 flex items-center gap-2">
              <span className="material-symbols-outlined text-[14px] text-mac-yellow">gavel</span>
              {a.pending} ({pendingQueue.length})
            </h3>
            {pendingQueue.length === 0 ? (
              <div className="flex flex-col items-center py-8 text-slate-400 dark:text-white/20">
                <span className="material-symbols-outlined text-3xl mb-2">{wsConnected ? 'check_circle' : 'cloud_off'}</span>
                <p className="text-[11px]">{a.noPending}</p>
                {wsConnected && <p className="text-[11px] mt-1 text-slate-400 dark:text-white/15">{a.wsLiveDesc}</p>}
              </div>
            ) : (
              <div className="space-y-3">
                {pendingQueue.map((item: any) => {
                  const req = item.request || {};
                  const remainMs = (item.expiresAtMs || 0) - Date.now();
                  const isExpired = remainMs <= 0;
                  return (
                    <div key={item.id} className={`rounded-xl border p-4 ${isExpired ? 'border-slate-200 dark:border-white/5 opacity-50' : 'border-mac-yellow/30 bg-mac-yellow/[0.03]'}`}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="text-[12px] font-bold font-mono text-slate-800 dark:text-white break-all">{req.command}</p>
                          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px]">
                            {req.host && <span className="text-slate-400 dark:text-white/35">{a.host}: <b className="text-slate-600 dark:text-white/50">{req.host}</b></span>}
                            {req.agentId && <span className="text-slate-400 dark:text-white/35">{a.agent}: <b className="text-slate-600 dark:text-white/50">{req.agentId}</b></span>}
                            {req.sessionKey && <span className="text-slate-400 dark:text-white/35">{a.session}: <b className="text-slate-600 dark:text-white/50 font-mono">{req.sessionKey}</b></span>}
                            {req.cwd && <span className="text-slate-400 dark:text-white/35">{a.cwd}: <b className="text-slate-600 dark:text-white/50 font-mono">{req.cwd}</b></span>}
                            {req.resolvedPath && <span className="text-slate-400 dark:text-white/35">{a.resolvedPath}: <b className="text-slate-600 dark:text-white/50 font-mono">{req.resolvedPath}</b></span>}
                            {req.security && <span className="text-slate-400 dark:text-white/35">{a.security}: <b className="text-slate-600 dark:text-white/50">{req.security}</b></span>}
                            {req.ask && <span className="text-slate-400 dark:text-white/35">{a.ask}: <b className="text-slate-600 dark:text-white/50">{req.ask}</b></span>}
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className={`text-[11px] font-bold ${isExpired ? 'text-mac-red' : 'text-mac-yellow'}`}>{isExpired ? a.expired : `${a.expiresIn} ${fmtRemaining(remainMs)}`}</p>
                          <div className="flex gap-1 mt-2">
                            <button onClick={() => handleDecision(item.id, 'allow-once')} disabled={busy || isExpired}
                              className="text-[11px] px-2 py-1 rounded-lg bg-mac-green/10 text-mac-green font-bold disabled:opacity-30">{a.allowOnce}</button>
                            <button onClick={() => handleDecision(item.id, 'allow-always')} disabled={busy || isExpired}
                              className="text-[11px] px-2 py-1 rounded-lg bg-primary/10 text-primary font-bold disabled:opacity-30">{a.allowAlways}</button>
                            <button onClick={() => handleDecision(item.id, 'deny')} disabled={busy || isExpired}
                              className="text-[11px] px-2 py-1 rounded-lg bg-mac-red/10 text-mac-red font-bold disabled:opacity-30">{a.deny}</button>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Policy Tab */}
        {tab === 'policy' && form && (
          <div className="space-y-4">
            {/* Scope Tabs */}
            <div className="flex gap-1.5 flex-wrap">
              <button onClick={() => setSelectedScope('__defaults__')}
                className={`px-2.5 py-1 rounded-lg text-[10px] font-bold transition-all ${isDefaults ? 'bg-primary text-white' : 'bg-slate-100 dark:bg-white/5 text-slate-500 dark:text-white/40'}`}>{a.defaults}</button>
              {agentIds.map(id => (
                <button key={id} onClick={() => setSelectedScope(id)}
                  className={`px-2.5 py-1 rounded-lg text-[10px] font-bold transition-all ${selectedScope === id ? 'bg-primary text-white' : 'bg-slate-100 dark:bg-white/5 text-slate-500 dark:text-white/40'}`}>{id}</button>
              ))}
            </div>

            <div className="rounded-2xl border border-slate-200/60 dark:border-white/[0.06] bg-white dark:bg-white/[0.02] p-4">
              <h3 className="text-[11px] font-bold text-slate-600 dark:text-white/60 uppercase tracking-wider mb-4">{a.policy} — {isDefaults ? a.defaults : selectedScope}</h3>
              <div className="space-y-3">
                {/* Security */}
                <div className="flex items-center justify-between gap-4 p-3 rounded-xl bg-slate-50 dark:bg-white/[0.03] border border-slate-100 dark:border-white/5">
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] font-bold text-slate-700 dark:text-white/70">{a.security}</p>
                    <p className="text-[11px] text-slate-400 dark:text-white/35 mt-0.5">{a.securityDesc}</p>
                    {!isDefaults && <p className="text-[11px] text-slate-400 dark:text-white/20 mt-0.5">{a.defaults}: {defaults.security || 'deny'}</p>}
                  </div>
                  <CustomSelect
                    value={isDefaults ? (scopeData.security || 'deny') : (scopeData.security ?? '__default__')}
                    onChange={v => {
                      const base = isDefaults ? ['defaults'] : ['agents', selectedScope];
                      if (!isDefaults && v === '__default__') removeFromForm([...base, 'security']);
                      else patchForm([...base, 'security'], v);
                    }}
                    options={[
                      ...(!isDefaults ? [{ value: '__default__', label: `${a.useDefault} (${defaults.security || 'deny'})` }] : []),
                      { value: 'deny', label: a.optDeny },
                      { value: 'allowlist', label: a.optAllowlist },
                      { value: 'full', label: a.optFull },
                    ]}
                    className="px-2.5 py-1.5 rounded-lg bg-white dark:bg-white/[0.03] border border-slate-200/60 dark:border-white/[0.06] text-[10px] text-slate-700 dark:text-white/70 shrink-0" />
                </div>
                {/* Ask */}
                <div className="flex items-center justify-between gap-4 p-3 rounded-xl bg-slate-50 dark:bg-white/[0.03] border border-slate-100 dark:border-white/5">
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] font-bold text-slate-700 dark:text-white/70">{a.ask}</p>
                    <p className="text-[11px] text-slate-400 dark:text-white/35 mt-0.5">{a.askDesc}</p>
                    {!isDefaults && <p className="text-[11px] text-slate-400 dark:text-white/20 mt-0.5">{a.defaults}: {defaults.ask || 'on-miss'}</p>}
                  </div>
                  <CustomSelect
                    value={isDefaults ? (scopeData.ask || 'on-miss') : (scopeData.ask ?? '__default__')}
                    onChange={v => {
                      const base = isDefaults ? ['defaults'] : ['agents', selectedScope];
                      if (!isDefaults && v === '__default__') removeFromForm([...base, 'ask']);
                      else patchForm([...base, 'ask'], v);
                    }}
                    options={[
                      ...(!isDefaults ? [{ value: '__default__', label: `${a.useDefault} (${defaults.ask || 'on-miss'})` }] : []),
                      { value: 'off', label: a.optAskOff },
                      { value: 'on-miss', label: a.optAskOnMiss },
                      { value: 'always', label: a.optAskAlways },
                    ]}
                    className="px-2.5 py-1.5 rounded-lg bg-white dark:bg-white/[0.03] border border-slate-200/60 dark:border-white/[0.06] text-[10px] text-slate-700 dark:text-white/70 shrink-0" />
                </div>
                {/* Ask Fallback */}
                <div className="flex items-center justify-between gap-4 p-3 rounded-xl bg-slate-50 dark:bg-white/[0.03] border border-slate-100 dark:border-white/5">
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] font-bold text-slate-700 dark:text-white/70">{a.askFallback}</p>
                    <p className="text-[11px] text-slate-400 dark:text-white/35 mt-0.5">{a.askFallbackDesc}</p>
                    {!isDefaults && <p className="text-[11px] text-slate-400 dark:text-white/20 mt-0.5">{a.defaults}: {defaults.askFallback || 'deny'}</p>}
                  </div>
                  <CustomSelect
                    value={isDefaults ? (scopeData.askFallback || 'deny') : (scopeData.askFallback ?? '__default__')}
                    onChange={v => {
                      const base = isDefaults ? ['defaults'] : ['agents', selectedScope];
                      if (!isDefaults && v === '__default__') removeFromForm([...base, 'askFallback']);
                      else patchForm([...base, 'askFallback'], v);
                    }}
                    options={[
                      ...(!isDefaults ? [{ value: '__default__', label: `${a.useDefault} (${defaults.askFallback || 'deny'})` }] : []),
                      { value: 'deny', label: a.optFallbackDeny },
                      { value: 'allowlist', label: a.optFallbackAllowlist },
                    ]}
                    className="px-2.5 py-1.5 rounded-lg bg-white dark:bg-white/[0.03] border border-slate-200/60 dark:border-white/[0.06] text-[10px] text-slate-700 dark:text-white/70 shrink-0" />
                </div>
                {/* Auto-allow skills */}
                <div className="flex items-center justify-between gap-4 p-3 rounded-xl bg-slate-50 dark:bg-white/[0.03] border border-slate-100 dark:border-white/5">
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] font-bold text-slate-700 dark:text-white/70">{a.autoAllowSkills}</p>
                    <p className="text-[11px] text-slate-400 dark:text-white/35 mt-0.5">{a.autoAllowSkillsDesc}</p>
                    {!isDefaults && <p className="text-[11px] text-slate-400 dark:text-white/20 mt-0.5">{a.defaults}: {defaults.autoAllowSkills ? a.on : a.off}</p>}
                  </div>
                  <label className="flex items-center gap-2 shrink-0">
                    <input type="checkbox" checked={scopeData.autoAllowSkills ?? defaults.autoAllowSkills ?? false}
                      onChange={e => {
                        const base = isDefaults ? ['defaults'] : ['agents', selectedScope];
                        patchForm([...base, 'autoAllowSkills'], e.target.checked);
                      }} className="accent-primary" />
                    <span className="text-[10px] text-slate-500 dark:text-white/40">{a.enabled}</span>
                  </label>
                </div>
              </div>
            </div>

          </div>
        )}

        {/* Notify Tab */}
        {tab === 'notify' && (
          <div className="rounded-2xl border border-slate-200/60 dark:border-white/[0.06] bg-white dark:bg-white/[0.02] p-4">
            <h3 className="text-[11px] font-bold text-slate-600 dark:text-white/60 uppercase tracking-wider mb-1">{a.fwdTitle}</h3>
            <p className="text-[11px] text-slate-400 dark:text-white/35 mb-4">{a.fwdDesc}</p>
            <div className="space-y-3">
              {/* Enable */}
              <div className="flex items-center justify-between gap-4 p-3 rounded-xl bg-slate-50 dark:bg-white/[0.03] border border-slate-100 dark:border-white/5">
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] font-bold text-slate-700 dark:text-white/70">{a.fwdEnabled}</p>
                  <p className="text-[11px] text-slate-400 dark:text-white/35 mt-0.5">{a.fwdEnabledDesc}</p>
                </div>
                <label className="flex items-center gap-2 shrink-0">
                  <input type="checkbox" checked={fwdEnabled}
                    onChange={e => { setFwdEnabled(e.target.checked); saveFwdField('enabled', e.target.checked); }}
                    className="accent-primary" />
                  <span className="text-[10px] text-slate-500 dark:text-white/40">{fwdEnabled ? a.on : a.off}</span>
                </label>
              </div>
              {/* Mode */}
              <div className="flex items-center justify-between gap-4 p-3 rounded-xl bg-slate-50 dark:bg-white/[0.03] border border-slate-100 dark:border-white/5">
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] font-bold text-slate-700 dark:text-white/70">{a.fwdMode}</p>
                  <p className="text-[11px] text-slate-400 dark:text-white/35 mt-0.5">{a.fwdModeDesc}</p>
                </div>
                <CustomSelect
                  value={fwdMode}
                  onChange={v => { setFwdMode(v); saveFwdField('mode', v); }}
                  options={[
                    { value: 'session', label: a.fwdModeSession },
                    { value: 'targets', label: a.fwdModeTargets },
                    { value: 'both', label: a.fwdModeBoth },
                  ]}
                  className="px-2.5 py-1.5 rounded-lg bg-white dark:bg-white/[0.03] border border-slate-200/60 dark:border-white/[0.06] text-[10px] text-slate-700 dark:text-white/70 shrink-0" />
              </div>
              {/* Targets */}
              {(fwdMode === 'targets' || fwdMode === 'both') && (
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-white/[0.03] border border-slate-100 dark:border-white/5">
                  <p className="text-[11px] font-bold text-slate-700 dark:text-white/70">{a.fwdTargets}</p>
                  <p className="text-[11px] text-slate-400 dark:text-white/35 mt-0.5 mb-2">{a.fwdTargetsDesc}</p>
                  <div className="space-y-1.5">
                    {fwdTargets.map((target, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <span className="flex-1 text-[10px] font-mono text-slate-600 dark:text-white/50 bg-white dark:bg-white/[0.03] border border-slate-200/60 dark:border-white/[0.06] rounded-lg px-2.5 py-1.5">{target}</span>
                        <button onClick={() => {
                          const next = fwdTargets.filter((_, j) => j !== i);
                          setFwdTargets(next);
                          saveFwdField('targets', next);
                        }} className="text-[11px] text-mac-red font-bold px-2 py-1 rounded-lg hover:bg-mac-red/10 transition-colors">{a.removePattern}</button>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-2 mt-2">
                    <input type="text" value={fwdNewTarget} onChange={e => setFwdNewTarget(e.target.value)}
                      placeholder={a.fwdTargetsPlaceholder}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && fwdNewTarget.trim()) {
                          const next = [...fwdTargets, fwdNewTarget.trim()];
                          setFwdTargets(next);
                          setFwdNewTarget('');
                          saveFwdField('targets', next);
                        }
                      }}
                      className="flex-1 text-[10px] font-mono bg-white dark:bg-white/[0.03] border border-slate-200/60 dark:border-white/[0.06] rounded-lg px-2.5 py-1.5 text-slate-700 dark:text-white/70 placeholder:text-slate-300 dark:placeholder:text-white/15 outline-none focus:ring-1 focus:ring-primary/30" />
                    <button onClick={() => {
                      if (fwdNewTarget.trim()) {
                        const next = [...fwdTargets, fwdNewTarget.trim()];
                        setFwdTargets(next);
                        setFwdNewTarget('');
                        saveFwdField('targets', next);
                      }
                    }} className="text-[11px] text-primary font-bold px-2.5 py-1.5 rounded-lg hover:bg-primary/10 transition-colors">{a.fwdTargetsAdd}</button>
                  </div>
                </div>
              )}
              {/* Agent Filter */}
              <div className="flex items-center justify-between gap-4 p-3 rounded-xl bg-slate-50 dark:bg-white/[0.03] border border-slate-100 dark:border-white/5">
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] font-bold text-slate-700 dark:text-white/70">{a.fwdAgentFilter}</p>
                  <p className="text-[11px] text-slate-400 dark:text-white/35 mt-0.5">{a.fwdAgentFilterDesc}</p>
                </div>
                <input type="text" value={fwdAgentFilter}
                  onChange={e => setFwdAgentFilter(e.target.value)}
                  onBlur={() => {
                    const arr = fwdAgentFilter.split(',').map(s => s.trim()).filter(Boolean);
                    saveFwdField('agentFilter', arr.length > 0 ? arr : null);
                  }}
                  placeholder="*"
                  className="w-32 text-[10px] font-mono bg-white dark:bg-white/[0.03] border border-slate-200/60 dark:border-white/[0.06] rounded-lg px-2.5 py-1.5 text-slate-700 dark:text-white/70 placeholder:text-slate-300 dark:placeholder:text-white/15 outline-none focus:ring-1 focus:ring-primary/30 shrink-0" />
              </div>
              {/* Session Filter */}
              <div className="flex items-center justify-between gap-4 p-3 rounded-xl bg-slate-50 dark:bg-white/[0.03] border border-slate-100 dark:border-white/5">
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] font-bold text-slate-700 dark:text-white/70">{a.fwdSessionFilter}</p>
                  <p className="text-[11px] text-slate-400 dark:text-white/35 mt-0.5">{a.fwdSessionFilterDesc}</p>
                </div>
                <input type="text" value={fwdSessionFilter}
                  onChange={e => setFwdSessionFilter(e.target.value)}
                  onBlur={() => {
                    const arr = fwdSessionFilter.split(',').map(s => s.trim()).filter(Boolean);
                    saveFwdField('sessionFilter', arr.length > 0 ? arr : null);
                  }}
                  placeholder="*"
                  className="w-32 text-[10px] font-mono bg-white dark:bg-white/[0.03] border border-slate-200/60 dark:border-white/[0.06] rounded-lg px-2.5 py-1.5 text-slate-700 dark:text-white/70 placeholder:text-slate-300 dark:placeholder:text-white/15 outline-none focus:ring-1 focus:ring-primary/30 shrink-0" />
              </div>
              {fwdSaving && <p className="text-[11px] text-slate-400 dark:text-white/35 text-center">{a.fwdSaving}</p>}
            </div>
          </div>
        )}

        {/* Allowlist Tab */}
        {tab === 'allowlist' && form && (
          <div className="space-y-4">
            {/* Scope Tabs (no defaults for allowlist) */}
            <div className="flex gap-1.5 flex-wrap">
              {agentIds.length === 0 ? (
                <p className="text-[10px] text-slate-400 dark:text-white/35">{a.noPatterns}</p>
              ) : agentIds.map(id => (
                <button key={id} onClick={() => setSelectedScope(id)}
                  className={`px-2.5 py-1 rounded-lg text-[10px] font-bold transition-all ${selectedScope === id ? 'bg-primary text-white' : 'bg-slate-100 dark:bg-white/5 text-slate-500 dark:text-white/40'}`}>{id}</button>
              ))}
            </div>

            {!isDefaults && (
              <div className="rounded-2xl border border-slate-200/60 dark:border-white/[0.06] bg-white dark:bg-white/[0.02] p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-[11px] font-bold text-slate-600 dark:text-white/60 uppercase tracking-wider flex items-center gap-2">
                    <span className="material-symbols-outlined text-[14px] text-primary">checklist</span>
                    {a.allowlist} — {selectedScope}
                  </h3>
                  <button onClick={() => patchForm(['agents', selectedScope, 'allowlist'], [...allowlist, { pattern: '' }])}
                    className="text-[10px] px-2.5 py-1 rounded-lg bg-primary/10 text-primary font-bold">{a.addPattern}</button>
                </div>
                {allowlist.length === 0 ? (
                  <p className="text-[10px] text-slate-400 dark:text-white/20 py-4 text-center">{a.noPatterns}</p>
                ) : (
                  <div className="space-y-2">
                    {allowlist.map((entry: any, i: number) => (
                      <div key={i} className="flex items-center gap-3 p-3 rounded-xl bg-slate-50 dark:bg-white/[0.03] border border-slate-100 dark:border-white/5">
                        <div className="flex-1 min-w-0">
                          <input value={entry.pattern || ''} placeholder="e.g. git *"
                            onChange={e => patchForm(['agents', selectedScope, 'allowlist', String(i), 'pattern'], e.target.value)}
                            className="w-full px-2 py-1.5 rounded-lg bg-white dark:bg-white/[0.03] border border-slate-200/60 dark:border-white/[0.06] text-[10px] font-mono text-slate-700 dark:text-white/70 focus:outline-none focus:ring-1 focus:ring-primary/30" />
                          <div className="flex gap-3 mt-1 text-[11px] text-slate-400 dark:text-white/35">
                            <span>{a.lastUsed}: {entry.lastUsedAt ? fmtRelative(entry.lastUsedAt) : a.never}</span>
                            {entry.lastUsedCommand && <span className="font-mono truncate">{entry.lastUsedCommand}</span>}
                          </div>
                        </div>
                        <button onClick={() => {
                          if (allowlist.length <= 1) removeFromForm(['agents', selectedScope, 'allowlist']);
                          else removeFromForm(['agents', selectedScope, 'allowlist', String(i)]);
                        }} className="text-[11px] px-2 py-1 rounded-lg bg-mac-red/10 text-mac-red shrink-0">{a.removePattern}</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {isDefaults && agentIds.length > 0 && (
              <p className="text-[10px] text-slate-400 dark:text-white/35 text-center py-4">{a.scope}: {a.defaults} — allowlists are per-agent only</p>
            )}
          </div>
        )}
      </div>
    </main>
  );
};

export default Alerts;
