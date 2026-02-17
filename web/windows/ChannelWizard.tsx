
import React, { useState, useMemo, useCallback } from 'react';
import StepWizard, { TipBox, StepCard, WizardStep } from '../components/StepWizard';
import { Language } from '../types';
import { getTranslation } from '../locales';
import { post } from '../services/request';
import { gatewayApi, pairingApi } from '../services/api';

interface Props { language: Language; }

type ChannelType = 'telegram' | 'discord' | 'slack' | 'whatsapp' | 'signal';
type DmPolicy = 'pairing' | 'allowlist' | 'open' | 'disabled';

interface ChannelDef {
  id: ChannelType; icon: string; color: string;
  tokenFields: { key: string; label: string; placeholder: string; required: boolean }[];
}

const CHANNELS: ChannelDef[] = [
  {
    id: 'telegram', icon: '✈️', color: 'text-sky-500',
    tokenFields: [{ key: 'botToken', label: 'botToken', placeholder: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11', required: true }]
  },
  {
    id: 'discord', icon: '🎮', color: 'text-indigo-500',
    tokenFields: [{ key: 'token', label: 'token', placeholder: 'MTIzNDU2Nzg5MDEyMzQ1Njc4.Gabcde.abcdefghijklmnopqrstuvwxyz', required: true }]
  },
  {
    id: 'slack', icon: '💬', color: 'text-purple-500',
    tokenFields: [
      { key: 'appToken', label: 'appToken', placeholder: 'xapp-1-A0123456789-...', required: true },
      { key: 'botToken', label: 'botToken', placeholder: 'xoxb-1234567890-...', required: true },
      { key: 'userToken', label: 'userToken', placeholder: 'xoxp-1234567890-...', required: false },
    ]
  },
  {
    id: 'whatsapp', icon: '📱', color: 'text-green-500',
    tokenFields: []
  },
  {
    id: 'signal', icon: '🔒', color: 'text-blue-500',
    tokenFields: [
      { key: 'account', label: 'account', placeholder: '+15551234567', required: true },
      { key: 'cliPath', label: 'cliPath', placeholder: 'signal-cli', required: false },
    ]
  },
];

const ChannelWizard: React.FC<Props> = ({ language }) => {
  const t = useMemo(() => getTranslation(language), [language]);
  const cw = (t as any).cw;

  const [step, setStep] = useState(0);
  const [selectedChannel, setSelectedChannel] = useState<ChannelType | ''>('');
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [showTokens, setShowTokens] = useState<Record<string, boolean>>({});
  const [dmPolicy, setDmPolicy] = useState<DmPolicy>('pairing');
  const [allowFrom, setAllowFrom] = useState('');
  const [requireMention, setRequireMention] = useState(true);
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [pairingCode, setPairingCode] = useState('');
  const [pairingStatus, setPairingStatus] = useState<'idle' | 'approving' | 'approved' | 'failed'>('idle');
  const [showPairingStep, setShowPairingStep] = useState(false);

  const channel = CHANNELS.find(c => c.id === selectedChannel);

  const steps: WizardStep[] = [
    { id: 'channel', icon: 'forum', title: cw.stepChannel },
    { id: 'prep', icon: 'checklist', title: cw.stepPrep },
    { id: 'credential', icon: 'key', title: cw.stepCredential },
    { id: 'access', icon: 'shield', title: cw.stepAccess },
    { id: 'confirm', icon: 'check_circle', title: cw.stepConfirm },
    ...(showPairingStep ? [{ id: 'pairing', icon: 'handshake', title: cw.pairingGuideTitle }] : []),
  ];

  const canNext = useMemo(() => {
    if (step === 0) return !!selectedChannel;
    if (step === 2 && channel) {
      return channel.tokenFields.filter(f => f.required).every(f => !!tokens[f.key]);
    }
    return true;
  }, [step, selectedChannel, channel, tokens]);

  const handleSelectChannel = useCallback((id: ChannelType) => {
    setSelectedChannel(id);
    setTokens({});
    setShowTokens({});
    setDmPolicy('pairing');
    setAllowFrom('');
    setRequireMention(true);
  }, []);

  const handleTestConnection = useCallback(async () => {
    setTestStatus('testing');
    try {
      await post('/api/v1/setup/test-channel', { channel: selectedChannel, tokens });
      setTestStatus('ok');
    } catch {
      setTestStatus('fail');
    }
    setTimeout(() => setTestStatus('idle'), 3000);
  }, [selectedChannel, tokens]);

  const finalConfig = useMemo(() => {
    if (!selectedChannel) return '{}';
    const cfg: any = { channels: { [selectedChannel]: { enabled: true } } };
    const ch = cfg.channels[selectedChannel];

    if (selectedChannel === 'telegram') {
      ch.botToken = tokens.botToken || 'YOUR_TOKEN';
      ch.dmPolicy = dmPolicy;
      if (allowFrom.trim()) ch.allowFrom = allowFrom.split('\n').map((s: string) => s.trim()).filter(Boolean);
      ch.groups = { '*': { requireMention } };
    } else if (selectedChannel === 'discord') {
      ch.token = tokens.token || 'YOUR_TOKEN';
      ch.dm = { enabled: true, policy: dmPolicy };
      if (allowFrom.trim()) ch.dm.allowFrom = allowFrom.split('\n').map((s: string) => s.trim()).filter(Boolean);
      ch.guilds = { '*': { requireMention } };
    } else if (selectedChannel === 'slack') {
      ch.appToken = tokens.appToken || 'xapp-...';
      ch.botToken = tokens.botToken || 'xoxb-...';
      if (tokens.userToken) ch.userToken = tokens.userToken;
    } else if (selectedChannel === 'whatsapp') {
      ch.dmPolicy = dmPolicy;
      if (allowFrom.trim()) ch.allowFrom = allowFrom.split('\n').map((s: string) => s.trim()).filter(Boolean);
    } else if (selectedChannel === 'signal') {
      ch.account = tokens.account || '+15551234567';
      if (tokens.cliPath) ch.cliPath = tokens.cliPath;
      ch.dmPolicy = dmPolicy;
      if (allowFrom.trim()) ch.allowFrom = allowFrom.split('\n').map((s: string) => s.trim()).filter(Boolean);
    }
    return JSON.stringify(cfg, null, 2);
  }, [selectedChannel, tokens, dmPolicy, allowFrom, requireMention]);

  const handleFinish = useCallback(async () => {
    setSaving(true);
    try {
      await post('/api/v1/config/channel-wizard', {
        channel: selectedChannel, tokens, dmPolicy,
        allowFrom: allowFrom.split('\n').map(s => s.trim()).filter(Boolean),
        requireMention,
      });
      setSaving(false);
      setRestarting(true);
      await gatewayApi.restart();
      setRestarting(false);
      // If pairing mode, show pairing step
      if (dmPolicy === 'pairing') {
        setShowPairingStep(true);
        setStep(5); // Go to pairing step
      }
    } catch { /* toast error */ }
    setSaving(false);
    setRestarting(false);
  }, [selectedChannel, tokens, dmPolicy, allowFrom, requireMention]);

  const handleApprovePairing = useCallback(async () => {
    if (!pairingCode.trim() || !selectedChannel) return;
    setPairingStatus('approving');
    try {
      await pairingApi.approve(selectedChannel, pairingCode.trim());
      setPairingStatus('approved');
    } catch {
      setPairingStatus('failed');
    }
  }, [selectedChannel, pairingCode]);

  const dmPolicies: { id: DmPolicy; icon: string }[] = [
    { id: 'pairing', icon: 'handshake' },
    { id: 'allowlist', icon: 'checklist' },
    { id: 'open', icon: 'lock_open' },
    { id: 'disabled', icon: 'block' },
  ];

  const prepSteps: string[] = selectedChannel ? ((cw as any)[`${selectedChannel}Prep`] || []) : [];

  return (
    <StepWizard steps={steps} currentStep={step} onStepChange={setStep} canNext={canNext}
      loading={saving} onFinish={handleFinish} finishLabel={cw.finish} nextLabel={cw.next} prevLabel={cw.back}>

      {/* Step 1: Select Channel */}
      {step === 0 && (
        <StepCard title={cw.stepChannel} subtitle={cw.subtitle} icon="forum">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {CHANNELS.map(ch => (
              <button key={ch.id} onClick={() => handleSelectChannel(ch.id)}
                className={`p-4 rounded-xl border-2 transition-all text-left ${selectedChannel === ch.id ? 'border-primary bg-primary/5 dark:bg-primary/10' : 'border-slate-200 dark:border-white/10 hover:border-primary/40'}`}>
                <div className="flex items-center gap-2.5 mb-2">
                  <span className="text-xl">{ch.icon}</span>
                  <span className="text-sm font-bold text-slate-800 dark:text-white/90">{(cw as any)[ch.id]}</span>
                </div>
                <p className="text-[11px] text-slate-500 dark:text-white/40 leading-relaxed">{(cw as any)[`${ch.id}Desc`]}</p>
              </button>
            ))}
          </div>
        </StepCard>
      )}

      {/* Step 2: Preparation */}
      {step === 1 && selectedChannel && (
        <StepCard title={cw.prepTitle} subtitle={cw.prepDesc} icon="checklist">
          <div className="space-y-3">
            {prepSteps.map((s: string, i: number) => (
              <div key={i} className="flex items-start gap-3 p-3 rounded-xl bg-slate-50 dark:bg-white/[0.03] border border-slate-200 dark:border-white/5">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center mt-0.5">
                  {i + 1}
                </span>
                <p className="text-xs text-slate-700 dark:text-white/70 leading-relaxed">{s}</p>
              </div>
            ))}
            <TipBox icon="warning" variant="warn">
              {(cw as any)[`${selectedChannel}Pitfall`]}
            </TipBox>
          </div>
        </StepCard>
      )}

      {/* Step 3: Credentials */}
      {step === 2 && channel && (
        <StepCard title={cw.stepCredential} icon="key">
          <div className="space-y-4">
            {channel.tokenFields.length === 0 && selectedChannel === 'whatsapp' && (
              <TipBox icon="info">
                {(t as any).menu?.whatsappTip}
              </TipBox>
            )}
            {channel.tokenFields.map(field => (
              <div key={field.key}>
                <label className="text-xs text-slate-500 dark:text-white/50 mb-1.5 flex items-center gap-2">
                  {(cw as any)[field.label] || field.label}
                  {!field.required && <span className="text-[10px] text-slate-400 dark:text-white/40">({cw.userTokenOptional})</span>}
                  {field.required && <span className="text-[10px] text-red-400">*</span>}
                </label>
                <div className="relative mt-1">
                  <input
                    type={showTokens[field.key] ? 'text' : 'password'}
                    value={tokens[field.key] || ''}
                    onChange={e => setTokens(prev => ({ ...prev, [field.key]: e.target.value }))}
                    placeholder={field.placeholder}
                    className="w-full px-3 py-2.5 pr-10 text-xs bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/50 font-mono"
                  />
                  <button onClick={() => setShowTokens(prev => ({ ...prev, [field.key]: !prev[field.key] }))}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-white/60">
                    <span className="material-symbols-outlined text-[16px]">{showTokens[field.key] ? 'visibility_off' : 'visibility'}</span>
                  </button>
                </div>
              </div>
            ))}

            {channel.tokenFields.some(f => f.required) && (
              <button onClick={handleTestConnection} disabled={testStatus === 'testing'}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-medium border border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-white/5 transition-all disabled:opacity-50">
                <span className={`material-symbols-outlined text-sm ${testStatus === 'testing' ? 'animate-spin' : ''} ${testStatus === 'ok' ? 'text-green-500' : testStatus === 'fail' ? 'text-red-500' : ''}`}>
                  {testStatus === 'testing' ? 'progress_activity' : testStatus === 'ok' ? 'check_circle' : testStatus === 'fail' ? 'error' : 'wifi_tethering'}
                </span>
                {testStatus === 'testing' ? cw.testing : testStatus === 'ok' ? cw.testOk : testStatus === 'fail' ? cw.testFail : cw.testConn}
              </button>
            )}

            {selectedChannel === 'discord' && <TipBox icon="warning" variant="warn">{cw.discordIntentWarn}</TipBox>}
            {selectedChannel === 'signal' && <TipBox icon="info">{cw.signalJavaWarn}</TipBox>}
          </div>
        </StepCard>
      )}

      {/* Step 4: Access Control */}
      {step === 3 && (
        <StepCard title={cw.stepAccess} icon="shield">
          <div className="space-y-5">
            {/* DM Policy */}
            <div>
              <label className="text-xs font-medium text-slate-700 dark:text-white/80 mb-2 block">{cw.dmPolicy}</label>
              <p className="text-[10px] text-slate-400 dark:text-white/40 mb-3">{cw.dmPolicyDesc}</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {dmPolicies.map(p => (
                  <button key={p.id} onClick={() => setDmPolicy(p.id)}
                    className={`p-3 rounded-xl border-2 transition-all text-center ${dmPolicy === p.id ? 'border-primary bg-primary/5 dark:bg-primary/10' : 'border-slate-200 dark:border-white/10 hover:border-primary/40'}`}>
                    <span className="material-symbols-outlined text-lg block mb-1">{p.icon}</span>
                    <div className="text-[11px] font-bold text-slate-700 dark:text-white/80">{(cw as any)[p.id]}</div>
                    <div className="text-[11px] text-slate-400 dark:text-white/40 mt-0.5">{(cw as any)[`${p.id}Desc`]}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Allowlist */}
            {(dmPolicy === 'allowlist' || dmPolicy === 'open') && (
              <div>
                <label className="text-xs text-slate-500 dark:text-white/50 mb-1.5 block">{cw.allowFrom}</label>
                <textarea
                  value={allowFrom}
                  onChange={e => setAllowFrom(e.target.value)}
                  placeholder={cw.allowFromPlaceholder}
                  rows={4}
                  className="w-full px-3 py-2.5 text-xs bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/50 font-mono resize-none"
                />
              </div>
            )}

            {/* Group mention */}
            {(selectedChannel === 'telegram' || selectedChannel === 'discord') && (
              <label className="flex items-center gap-3 p-3 rounded-xl border border-slate-200 dark:border-white/10 cursor-pointer hover:bg-slate-50 dark:hover:bg-white/[0.02]">
                <input type="checkbox" checked={requireMention} onChange={e => setRequireMention(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-300 text-primary focus:ring-primary/50" />
                <div>
                  <div className="text-xs font-medium text-slate-700 dark:text-white/80">{cw.requireMention}</div>
                  <div className="text-[10px] text-slate-400 dark:text-white/40 mt-0.5">{cw.requireMentionDesc}</div>
                </div>
              </label>
            )}

            {selectedChannel === 'discord' && !requireMention && (
              <TipBox icon="warning" variant="warn">{cw.discordMentionWarn}</TipBox>
            )}
          </div>
        </StepCard>
      )}

      {/* Step 5: Confirm */}
      {step === 4 && (
        <StepCard title={cw.stepConfirm} subtitle={cw.configSummary} icon="check_circle">
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <div className="p-3 rounded-xl bg-slate-50 dark:bg-white/5">
                <div className="text-[10px] text-slate-400 dark:text-white/40">{cw.stepChannel}</div>
                <div className="text-xs font-bold text-slate-800 dark:text-white/90 mt-0.5">
                  {channel?.icon} {(cw as any)[selectedChannel]}
                </div>
              </div>
              <div className="p-3 rounded-xl bg-slate-50 dark:bg-white/5">
                <div className="text-[10px] text-slate-400 dark:text-white/40">{cw.dmPolicy}</div>
                <div className="text-xs font-bold text-slate-800 dark:text-white/90 mt-0.5">{(cw as any)[dmPolicy]}</div>
              </div>
              {(selectedChannel === 'telegram' || selectedChannel === 'discord') && (
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-white/5">
                  <div className="text-[10px] text-slate-400 dark:text-white/40">{cw.requireMention}</div>
                  <div className="text-xs font-bold text-slate-800 dark:text-white/90 mt-0.5">
                    {requireMention ? '✅' : '❌'}
                  </div>
                </div>
              )}
            </div>

            {restarting && (
              <div className="flex items-center gap-3 p-4 rounded-xl bg-primary/10 border border-primary/20">
                <span className="material-symbols-outlined text-primary animate-spin">progress_activity</span>
                <span className="text-sm text-primary font-medium">{cw.restartingGateway}</span>
              </div>
            )}
          </div>
        </StepCard>
      )}

      {/* Step 6: Pairing (only shown after finish if dmPolicy is pairing) */}
      {step === 5 && showPairingStep && (
        <StepCard title={cw.pairingGuideTitle} icon="handshake">
          <div className="space-y-4">
            <p className="text-sm text-slate-600 dark:text-white/70">{cw.pairingGuideDesc}</p>
            
            <div className="space-y-2">
              {[cw.pairingStep1, cw.pairingStep2, cw.pairingStep3].map((s: string, i: number) => (
                <div key={i} className="flex items-start gap-3 p-3 rounded-xl bg-slate-50 dark:bg-white/[0.03] border border-slate-200 dark:border-white/5">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center">
                    {i + 1}
                  </span>
                  <p className="text-xs text-slate-700 dark:text-white/70 leading-relaxed">{s}</p>
                </div>
              ))}
            </div>

            <div className="pt-2">
              <label className="text-xs text-slate-500 dark:text-white/50 mb-1.5 block">{cw.pairingCodeLabel}</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={pairingCode}
                  onChange={e => setPairingCode(e.target.value.toUpperCase())}
                  placeholder={cw.pairingCodePlaceholder}
                  className="flex-1 px-3 py-2.5 text-xs bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/50 font-mono uppercase"
                  disabled={pairingStatus === 'approving' || pairingStatus === 'approved'}
                />
                <button
                  onClick={handleApprovePairing}
                  disabled={!pairingCode.trim() || pairingStatus === 'approving' || pairingStatus === 'approved'}
                  className="px-4 py-2.5 rounded-xl text-xs font-medium bg-primary text-white hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-2"
                >
                  {pairingStatus === 'approving' && <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>}
                  {pairingStatus === 'approving' ? cw.pairingApproving : cw.pairingApprove}
                </button>
              </div>
            </div>

            {pairingStatus === 'approved' && (
              <div className="flex items-center gap-2 p-3 rounded-xl bg-green-50 dark:bg-green-500/10 border border-green-200 dark:border-green-500/20 text-green-700 dark:text-green-400">
                <span className="material-symbols-outlined text-lg">check_circle</span>
                <span className="text-sm font-medium">{cw.pairingApproved}</span>
              </div>
            )}

            {pairingStatus === 'failed' && (
              <div className="flex items-center gap-2 p-3 rounded-xl bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 text-red-700 dark:text-red-400">
                <span className="material-symbols-outlined text-lg">error</span>
                <span className="text-sm font-medium">{cw.pairingFailed}</span>
              </div>
            )}
          </div>
        </StepCard>
      )}
    </StepWizard>
  );
};

export default ChannelWizard;
