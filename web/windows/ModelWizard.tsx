
import React, { useState, useMemo, useCallback } from 'react';
import StepWizard, { TipBox, StepCard, WizardStep } from '../components/StepWizard';
import { Language } from '../types';
import { getTranslation } from '../locales';
import { post } from '../services/request';

interface Props { language: Language; }

interface ProviderDef {
  id: string; name: string; icon: string; category: 'builtin' | 'custom' | 'local';
  envVar: string; defaultModel: string;
  models: { id: string; name: string; ctx?: string }[];
  baseUrl?: string; apiType?: string; needsBaseUrl?: boolean; helpUrl?: string;
}

const PROVIDERS: ProviderDef[] = [
  { id: 'anthropic', name: 'Anthropic', icon: '🅰️', category: 'builtin', envVar: 'ANTHROPIC_API_KEY', defaultModel: 'claude-sonnet-4-5', models: [{ id: 'claude-opus-4-6', name: 'Claude Opus 4', ctx: '200K' }, { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', ctx: '200K' }, { id: 'claude-sonnet-4-1', name: 'Claude Sonnet 4.1', ctx: '200K' }], helpUrl: 'https://console.anthropic.com' },
  { id: 'openai', name: 'OpenAI', icon: '🤖', category: 'builtin', envVar: 'OPENAI_API_KEY', defaultModel: 'gpt-4o', models: [{ id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex', ctx: '256K' }, { id: 'gpt-4o', name: 'GPT-4o', ctx: '128K' }, { id: 'o3', name: 'o3', ctx: '200K' }], helpUrl: 'https://platform.openai.com' },
  { id: 'google', name: 'Gemini', icon: '💎', category: 'builtin', envVar: 'GEMINI_API_KEY', defaultModel: 'gemini-2.0-flash', models: [{ id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro', ctx: '1M' }, { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', ctx: '1M' }], helpUrl: 'https://aistudio.google.com' },
  { id: 'moonshot', name: 'Moonshot', icon: '🌙', category: 'custom', envVar: 'MOONSHOT_API_KEY', defaultModel: 'kimi-k2.5', models: [{ id: 'kimi-k2.5', name: 'Kimi K2.5', ctx: '128K' }, { id: 'kimi-k2-thinking', name: 'Kimi K2 Thinking', ctx: '128K' }], baseUrl: 'https://api.moonshot.ai/v1', apiType: 'openai-completions', needsBaseUrl: true, helpUrl: 'https://platform.moonshot.cn' },
  { id: 'deepseek', name: 'DeepSeek', icon: '🔍', category: 'custom', envVar: 'DEEPSEEK_API_KEY', defaultModel: 'deepseek-chat', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', ctx: '64K' }, { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', ctx: '64K' }], baseUrl: 'https://api.deepseek.com/v1', apiType: 'openai-completions', needsBaseUrl: true, helpUrl: 'https://platform.deepseek.com' },
  { id: 'openrouter', name: 'OpenRouter', icon: '🔀', category: 'custom', envVar: 'OPENROUTER_API_KEY', defaultModel: '', models: [], apiType: 'openai-completions', helpUrl: 'https://openrouter.ai' },
  { id: 'ollama', name: 'Ollama', icon: '🦙', category: 'local', envVar: '', defaultModel: 'llama3.3', models: [{ id: 'llama3.3', name: 'Llama 3.3', ctx: '128K' }, { id: 'gpt-oss:20b', name: 'GPT-OSS 20B', ctx: '8K' }, { id: 'qwen2.5-coder:32b', name: 'Qwen 2.5 Coder 32B', ctx: '32K' }], baseUrl: 'http://127.0.0.1:11434/v1', apiType: 'openai-completions' },
  { id: 'custom', name: 'Custom', icon: '⚙️', category: 'custom', envVar: '', defaultModel: '', models: [], needsBaseUrl: true, apiType: 'openai-completions' },
];

const ModelWizard: React.FC<Props> = ({ language }) => {
  const t = useMemo(() => getTranslation(language), [language]);
  const mw = (t as any).mw;

  const [step, setStep] = useState(0);
  const [selectedProvider, setSelectedProvider] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [selectedModel, setSelectedModel] = useState('');
  const [customModelId, setCustomModelId] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiType, setApiType] = useState('openai-completions');
  const [fallbackModel, setFallbackModel] = useState('');
  const [streaming, setStreaming] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');

  const provider = PROVIDERS.find(p => p.id === selectedProvider);
  const finalModel = selectedModel || customModelId;

  const steps: WizardStep[] = [
    { id: 'provider', icon: 'dns', title: mw.stepProvider },
    { id: 'credential', icon: 'key', title: mw.stepCredential },
    { id: 'model', icon: 'smart_toy', title: mw.stepModel },
    { id: 'advanced', icon: 'tune', title: mw.stepAdvanced },
    { id: 'confirm', icon: 'check_circle', title: mw.stepConfirm },
  ];

  const canNext = useMemo(() => {
    if (step === 0) return !!selectedProvider;
    if (step === 2) return !!finalModel;
    return true;
  }, [step, selectedProvider, finalModel]);

  const handleSelectProvider = useCallback((id: string) => {
    setSelectedProvider(id);
    const p = PROVIDERS.find(x => x.id === id);
    if (p) {
      setSelectedModel(p.defaultModel);
      setCustomModelId('');
      setBaseUrl(p.baseUrl || '');
      setApiType(p.apiType || 'openai-completions');
      setStreaming(id !== 'ollama');
    }
  }, []);

  const handleTestConnection = useCallback(async () => {
    setTestStatus('testing');
    try {
      await post('/api/v1/setup/test-model', { provider: selectedProvider, apiKey, baseUrl, model: finalModel });
      setTestStatus('ok');
    } catch {
      setTestStatus('fail');
    }
    setTimeout(() => setTestStatus('idle'), 3000);
  }, [selectedProvider, apiKey, baseUrl, finalModel]);

  const finalConfig = useMemo(() => {
    const cfg: any = {};
    if (provider && (provider.needsBaseUrl || provider.category === 'custom' || provider.category === 'local')) {
      cfg.models = {
        mode: 'merge', providers: {
          [selectedProvider]: {
            baseUrl: baseUrl || provider.baseUrl,
            ...(apiKey ? { apiKey: `\${${provider.envVar || 'API_KEY'}}` } : {}),
            api: apiType,
            models: [{ id: finalModel, name: finalModel }],
          }
        }
      };
    }
    cfg.agents = {
      defaults: {
        model: {
          primary: `${selectedProvider}/${finalModel}`,
          ...(fallbackModel ? { fallbacks: [fallbackModel] } : {}),
        }
      }
    };
    return JSON.stringify(cfg, null, 2);
  }, [selectedProvider, apiKey, baseUrl, apiType, finalModel, fallbackModel, provider]);

  const handleFinish = useCallback(async () => {
    setSaving(true);
    try {
      await post('/api/v1/config/model-wizard', { provider: selectedProvider, apiKey, baseUrl, model: finalModel, apiType, fallbackModel, streaming });
    } catch { /* toast error */ }
    setSaving(false);
  }, [selectedProvider, apiKey, baseUrl, finalModel, apiType, fallbackModel, streaming]);

  const renderProviderCard = (p: ProviderDef) => (
    <button key={p.id} onClick={() => handleSelectProvider(p.id)}
      className={`p-3 rounded-xl border-2 transition-all text-left ${selectedProvider === p.id ? 'border-primary bg-primary/5 dark:bg-primary/10' : 'border-slate-200 dark:border-white/10 hover:border-primary/40'}`}>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-lg">{p.icon}</span>
        <span className="text-xs font-bold text-slate-800 dark:text-white/90">{p.name}</span>
      </div>
      <p className="text-[10px] text-slate-500 dark:text-white/40 line-clamp-2">{(mw as any)[`${p.id}Desc`] || mw.customProviderDesc}</p>
    </button>
  );

  const renderCategorySection = (label: string, icon: string, items: ProviderDef[]) => (
    <div>
      <div className="text-[11px] font-medium text-slate-500 dark:text-white/40 mb-2 flex items-center gap-1.5">
        <span className="material-symbols-outlined text-xs">{icon}</span>{label}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">{items.map(renderProviderCard)}</div>
    </div>
  );

  return (
    <StepWizard steps={steps} currentStep={step} onStepChange={setStep} canNext={canNext}
      loading={saving} onFinish={handleFinish} finishLabel={mw.finish} nextLabel={mw.next} prevLabel={mw.back}>

      {/* Step 1: Provider */}
      {step === 0 && (
        <StepCard title={mw.stepProvider} subtitle={mw.subtitle} icon="dns">
          <div className="space-y-4">
            {renderCategorySection(mw.builtIn, 'verified', PROVIDERS.filter(p => p.category === 'builtin'))}
            {renderCategorySection(mw.custom, 'settings', PROVIDERS.filter(p => p.category === 'custom'))}
            {renderCategorySection(mw.local, 'computer', PROVIDERS.filter(p => p.category === 'local'))}
          </div>
        </StepCard>
      )}

      {/* Step 2: Credentials */}
      {step === 1 && provider && (
        <StepCard title={mw.stepCredential} subtitle={(mw as any)[`${selectedProvider}Tip`]} icon="key">
          <div className="space-y-4">
            {provider.id !== 'ollama' && (
              <div>
                <label className="text-xs text-slate-500 dark:text-white/50 mb-1.5 flex items-center gap-2">
                  {mw.apiKey}
                  {provider.envVar && <span className="text-[10px] px-1.5 py-0.5 bg-slate-100 dark:bg-white/5 rounded font-mono">{provider.envVar}</span>}
                </label>
                <div className="relative mt-1">
                  <input type={showKey ? 'text' : 'password'} value={apiKey} onChange={e => setApiKey(e.target.value)}
                    placeholder={mw.apiKeyPlaceholder}
                    className="w-full px-3 py-2.5 pr-10 text-xs bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/50 font-mono" />
                  <button onClick={() => setShowKey(!showKey)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-white/60">
                    <span className="material-symbols-outlined text-[16px]">{showKey ? 'visibility_off' : 'visibility'}</span>
                  </button>
                </div>
                {provider.helpUrl && (
                  <a href={provider.helpUrl} target="_blank" rel="noopener noreferrer" className="text-[10px] text-primary hover:underline mt-1.5 inline-flex items-center gap-1">
                    <span className="material-symbols-outlined text-xs">open_in_new</span>
                    {mw.apiKeyHelp}: {provider.helpUrl}
                  </a>
                )}
              </div>
            )}
            {(provider.needsBaseUrl || provider.category === 'local') && (
              <div>
                <label className="text-xs text-slate-500 dark:text-white/50 mb-1.5 block">{mw.baseUrl}</label>
                <input type="text" value={baseUrl} onChange={e => setBaseUrl(e.target.value)}
                  placeholder={provider.baseUrl || mw.baseUrlPlaceholder}
                  className="w-full px-3 py-2.5 text-xs bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/50 font-mono" />
                {provider.needsBaseUrl && <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-1">{mw.baseUrlRequired}</p>}
              </div>
            )}
            <button onClick={handleTestConnection} disabled={testStatus === 'testing'}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-medium border border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-white/5 transition-all disabled:opacity-50">
              <span className={`material-symbols-outlined text-sm ${testStatus === 'testing' ? 'animate-spin' : ''} ${testStatus === 'ok' ? 'text-green-500' : testStatus === 'fail' ? 'text-red-500' : ''}`}>
                {testStatus === 'testing' ? 'progress_activity' : testStatus === 'ok' ? 'check_circle' : testStatus === 'fail' ? 'error' : 'wifi_tethering'}
              </span>
              {testStatus === 'testing' ? mw.testing : testStatus === 'ok' ? mw.testOk : testStatus === 'fail' ? mw.testFail : mw.testConn}
            </button>
            {provider.id === 'ollama' && <TipBox icon="lightbulb">{(mw as any).ollamaTip}</TipBox>}
            {!apiKey && provider.id !== 'ollama' && <TipBox icon="info" variant="warn">{mw.noKey} — {mw.noKeyDesc}</TipBox>}
          </div>
        </StepCard>
      )}

      {/* Step 3: Model */}
      {step === 2 && provider && (
        <StepCard title={mw.stepModel} subtitle={mw.selectModel} icon="smart_toy">
          <div className="space-y-4">
            {provider.models.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {provider.models.map(m => (
                  <button key={m.id} onClick={() => { setSelectedModel(m.id); setCustomModelId(''); }}
                    className={`p-3 rounded-xl border-2 transition-all text-left ${selectedModel === m.id ? 'border-primary bg-primary/5 dark:bg-primary/10' : 'border-slate-200 dark:border-white/10 hover:border-primary/40'}`}>
                    <div className="text-xs font-bold text-slate-800 dark:text-white/90">{m.name}</div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-[10px] font-mono text-slate-400 dark:text-white/40">{m.id}</span>
                      {m.ctx && <span className="text-[10px] px-1.5 py-0.5 bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded">{m.ctx}</span>}
                    </div>
                  </button>
                ))}
              </div>
            )}
            <div>
              <label className="text-xs text-slate-500 dark:text-white/50 mb-1.5 block">{mw.modelId}</label>
              <input type="text" value={customModelId} onChange={e => { setCustomModelId(e.target.value); setSelectedModel(''); }}
                placeholder={mw.modelIdPlaceholder}
                className="w-full px-3 py-2.5 text-xs bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/50 font-mono" />
            </div>
            {provider.id === 'openrouter' && <TipBox icon="warning" variant="warn">{mw.pitfallOpenrouterSlash}</TipBox>}
          </div>
        </StepCard>
      )}

      {/* Step 4: Advanced */}
      {step === 3 && provider && (
        <StepCard title={mw.stepAdvanced} icon="tune">
          <div className="space-y-4">
            {!provider.needsBaseUrl && provider.category !== 'local' && (
              <div>
                <label className="text-xs text-slate-500 dark:text-white/50 mb-1.5 block">{mw.baseUrl}</label>
                <input type="text" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder={mw.baseUrlPlaceholder}
                  className="w-full px-3 py-2.5 text-xs bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/50 font-mono" />
              </div>
            )}
            <div>
              <label className="text-xs text-slate-500 dark:text-white/50 mb-1.5 block">{mw.apiType}</label>
              <div className="flex gap-2">
                {['openai-completions', 'anthropic-messages'].map(at => (
                  <button key={at} onClick={() => setApiType(at)}
                    className={`px-3 py-2 rounded-xl text-[11px] font-medium border-2 transition-all ${apiType === at ? 'border-primary bg-primary/5 dark:bg-primary/10 text-primary' : 'border-slate-200 dark:border-white/10 text-slate-600 dark:text-white/50'}`}>
                    {at === 'openai-completions' ? mw.apiTypeOAI : mw.apiTypeAnthropic}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs text-slate-500 dark:text-white/50 mb-1.5 block">{mw.fallbackModel}</label>
              <input type="text" value={fallbackModel} onChange={e => setFallbackModel(e.target.value)}
                placeholder="e.g. anthropic/claude-sonnet-4-5"
                className="w-full px-3 py-2.5 text-xs bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/50 font-mono" />
              <p className="text-[10px] text-slate-400 dark:text-white/40 mt-1">{mw.fallbackModelDesc}</p>
            </div>
            <label className="flex items-center gap-3 p-3 rounded-xl border border-slate-200 dark:border-white/10 cursor-pointer hover:bg-slate-50 dark:hover:bg-white/[0.02]">
              <input type="checkbox" checked={streaming} onChange={e => setStreaming(e.target.checked)}
                className="w-4 h-4 rounded border-slate-300 text-primary focus:ring-primary/50" />
              <div>
                <div className="text-xs font-medium text-slate-700 dark:text-white/80">{mw.streaming}</div>
                <div className="text-[10px] text-slate-400 dark:text-white/40 mt-0.5">{mw.streamingDesc}</div>
              </div>
            </label>
            {provider.id === 'ollama' && <TipBox icon="warning" variant="warn">{mw.pitfallOllamaStream}</TipBox>}
          </div>
        </StepCard>
      )}

      {/* Step 5: Confirm */}
      {step === 4 && (
        <StepCard title={mw.stepConfirm} subtitle={mw.configSummary} icon="check_circle">
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 rounded-xl bg-slate-50 dark:bg-white/5">
                <div className="text-[10px] text-slate-400 dark:text-white/40">{mw.provider}</div>
                <div className="text-xs font-bold text-slate-800 dark:text-white/90 mt-0.5">{provider?.icon} {provider?.name}</div>
              </div>
              <div className="p-3 rounded-xl bg-slate-50 dark:bg-white/5">
                <div className="text-[10px] text-slate-400 dark:text-white/40">{mw.model}</div>
                <div className="text-xs font-bold text-slate-800 dark:text-white/90 mt-0.5 font-mono">{finalModel}</div>
              </div>
            </div>
            {apiKey && (
              <div className="p-3 rounded-xl bg-green-50 dark:bg-green-500/10 border border-green-200 dark:border-green-500/20">
                <div className="flex items-center gap-2 text-xs text-green-700 dark:text-green-400">
                  <span className="material-symbols-outlined text-sm">check_circle</span>
                  API Key {mw.testOk?.toLowerCase() || 'configured'}
                </div>
              </div>
            )}
            <div>
              <div className="text-[10px] text-slate-400 dark:text-white/40 mb-1.5">{mw.configPreview}</div>
              <pre className="p-3 rounded-xl bg-slate-900 dark:bg-black/40 text-green-400 text-[11px] font-mono overflow-x-auto max-h-48 overflow-y-auto custom-scrollbar leading-relaxed">{finalConfig}</pre>
            </div>
          </div>
        </StepCard>
      )}
    </StepWizard>
  );
};

export default ModelWizard;
