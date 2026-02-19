
import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { Language } from '../types';
import { getTranslation } from '../locales';
import { gwApi, clawHubApi, skillTranslationApi } from '../services/api';
import { useToast } from '../components/Toast';

interface SkillsProps { language: Language; }

// 技能状态数据类型（来自 skills.status JSON-RPC）
interface SkillStatus {
  name: string; description: string; source: string; bundled: boolean;
  filePath: string; baseDir: string; skillKey: string;
  primaryEnv?: string; emoji?: string; homepage?: string;
  always: boolean; disabled: boolean; blockedByAllowlist: boolean; eligible: boolean;
  requirements: { bins: string[]; anyBins: string[]; env: string[]; config: string[]; os: string[] };
  missing: { bins: string[]; anyBins: string[]; env: string[]; config: string[]; os: string[] };
  configChecks: { path: string; value: unknown; satisfied: boolean }[];
  install: { id: string; kind: string; label: string; bins: string[] }[];
}

interface SkillsConfig { [key: string]: { enabled?: boolean; apiKey?: string; env?: Record<string, string> } }

type TabId = 'all' | 'eligible' | 'missing' | 'market';
type FilterId = 'all' | 'eligible' | 'missing';

type SkillMessage = { kind: 'success' | 'error'; message: string };
type SkillMessageMap = Record<string, SkillMessage>;

// 可展开描述组件
const ExpandableDesc: React.FC<{ text: string }> = ({ text }) => {
  const [expanded, setExpanded] = useState(false);
  if (!text) return null;
  const needsExpand = text.length > 80;
  return (
    <div className="mb-3">
      <p className={`text-[11px] text-slate-500 dark:text-white/40 leading-relaxed ${needsExpand ? 'cursor-pointer' : ''} ${expanded ? '' : 'line-clamp-2'}`}
        onClick={() => needsExpand && setExpanded(!expanded)}>
        {text}
      </p>
      {needsExpand && !expanded && (
        <button onClick={() => setExpanded(true)} className="text-[11px] text-primary/70 hover:text-primary font-medium mt-0.5">...more</button>
      )}
    </div>
  );
};

const SOURCE_GROUPS = [
  { id: 'workspace', sources: ['openclaw-workspace'] },
  { id: 'builtIn', sources: ['openclaw-bundled'] },
  { id: 'installedSkills', sources: ['openclaw-managed'] },
  { id: 'extra', sources: ['openclaw-extra'] },
];

function groupSkills(skills: SkillStatus[], sk: any): { id: string; label: string; skills: SkillStatus[] }[] {
  const groups = new Map<string, { id: string; label: string; skills: SkillStatus[] }>();
  for (const def of SOURCE_GROUPS) groups.set(def.id, { id: def.id, label: sk[def.id] || def.id, skills: [] });
  const other = { id: 'other', label: sk.other || 'Other', skills: [] as SkillStatus[] };
  const builtInDef = SOURCE_GROUPS.find(g => g.id === 'builtIn');
  for (const skill of skills) {
    const match = skill.bundled ? builtInDef : SOURCE_GROUPS.find(g => g.sources.includes(skill.source));
    if (match) groups.get(match.id)?.skills.push(skill);
    else other.skills.push(skill);
  }
  const ordered = SOURCE_GROUPS.map(g => groups.get(g.id)).filter((g): g is NonNullable<typeof g> => !!g && g.skills.length > 0);
  if (other.skills.length > 0) ordered.push(other);
  return ordered;
}

// 构建本地技能安装 prompt
function buildInstallPrompt(skill: SkillStatus, sk: any): string {
  const lines: string[] = [sk.installPromptIntro, ''];
  lines.push(`- ${sk.installPromptName}: ${skill.name}`);
  if (skill.description) lines.push(`- ${sk.installPromptDesc}: ${skill.description}`);
  lines.push(`- ${sk.installPromptSource}: ${skill.source}`);
  const allMissingBins = [...skill.missing.bins, ...((skill.missing as any).anyBins || [])];
  if (allMissingBins.length > 0) lines.push(`- ${sk.installPromptDeps}: ${allMissingBins.join(', ')}`);
  if (skill.missing.env.length > 0) lines.push(`- ${sk.installPromptEnv}: ${skill.missing.env.join(', ')}`);
  if (skill.missing.config.length > 0) lines.push(`- ${sk.installPromptConfig}: ${skill.missing.config.join(', ')}`);
  if (skill.install.length > 0) {
    lines.push(`- ${sk.installPromptInstallCmd}: ${skill.install.map(i => i.label).join(', ')}`);
  }
  lines.push('', sk.installPromptSteps);
  return lines.join('\n');
}

// 构建市场技能安装 prompt
function buildMarketInstallPrompt(item: any, sk: any): string {
  const slug = item.slug || item.name || '';
  const lines: string[] = [sk.installPromptMarket, ''];
  lines.push(`- ${sk.installPromptSlug}: ${slug}`);
  lines.push(`- ${sk.installPromptName}: ${item.displayName || item.name || slug}`);
  if (item.summary || item.description) lines.push(`- ${sk.installPromptDesc}: ${item.summary || item.description}`);
  lines.push('', (sk.installPromptMarketSteps || '').replace('{slug}', slug));
  return lines.join('\n');
}

// 配置弹窗
const ConfigModal: React.FC<{
  skill: SkillStatus; config: SkillsConfig; language: Language;
  onSave: (skillKey: string, data: { enabled?: boolean; apiKey?: string; env?: Record<string, string> }) => Promise<void>;
  onClose: () => void;
}> = ({ skill, config, language, onSave, onClose }) => {
  const sk = (getTranslation(language) as any).sk;
  const entry = config[skill.skillKey] || {};
  const [enabled, setEnabled] = useState(entry.enabled !== false);
  const [apiKey, setApiKey] = useState(entry.apiKey || '');
  const [envPairs, setEnvPairs] = useState<[string, string][]>(() => {
    const e = entry.env || {};
    const pairs = Object.entries(e) as [string, string][];
    // 补充 missing env 的空行
    for (const envName of skill.missing.env) {
      if (!pairs.some(([k]) => k === envName)) pairs.push([envName, '']);
    }
    return pairs.length > 0 ? pairs : [['', '']];
  });
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const env: Record<string, string> = {};
      for (const [k, v] of envPairs) { if (k.trim()) env[k.trim()] = v; }
      await onSave(skill.skillKey, { enabled, apiKey: apiKey.trim() || undefined, env: Object.keys(env).length > 0 ? env : undefined });
      onClose();
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-md mx-4 bg-white dark:bg-[#1c1e24] rounded-2xl shadow-2xl border border-slate-200 dark:border-white/10 overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-slate-200 dark:border-white/5 flex items-center gap-3">
          <span className="text-xl">{skill.emoji || '⚙️'}</span>
          <div className="flex-1 min-w-0">
            <h3 className="font-bold text-sm text-slate-800 dark:text-white truncate">{sk.configureSkill}: {skill.name}</h3>
            <p className="text-[10px] text-slate-400 truncate">{skill.skillKey}</p>
          </div>
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-white/10">
            <span className="material-symbols-outlined text-[16px] text-slate-400">close</span>
          </button>
        </div>
        <div className="p-5 space-y-4 max-h-[60vh] overflow-y-auto custom-scrollbar">
          {/* 启用/禁用 */}
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-700 dark:text-white/80">{enabled ? sk.enable : sk.disable}</span>
            <button onClick={() => setEnabled(!enabled)} className={`w-10 h-5 rounded-full transition-colors relative ${enabled ? 'bg-mac-green' : 'bg-slate-300 dark:bg-white/20'}`}>
              <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </button>
          </div>
          {/* API Key */}
          {skill.primaryEnv && (
            <div>
              <label className="text-[10px] font-bold text-slate-500 dark:text-white/40 uppercase tracking-wider mb-1 block">{sk.apiKey} ({skill.primaryEnv})</label>
              <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={skill.primaryEnv}
                className="w-full h-9 px-3 bg-slate-50 dark:bg-black/30 border border-slate-200 dark:border-white/10 rounded-lg text-xs font-mono text-slate-800 dark:text-white outline-none focus:border-primary" />
            </div>
          )}
          {/* 环境变量 */}
          <div>
            <label className="text-[10px] font-bold text-slate-500 dark:text-white/40 uppercase tracking-wider mb-1 block">{sk.envVars}</label>
            {envPairs.map(([k, v], i) => (
              <div key={i} className="flex gap-1.5 mb-1.5">
                <input value={k} onChange={e => { const n = [...envPairs]; n[i] = [e.target.value, v]; setEnvPairs(n); }} placeholder="KEY"
                  className="flex-1 h-8 px-2 bg-slate-50 dark:bg-black/30 border border-slate-200 dark:border-white/10 rounded text-[10px] font-mono text-slate-800 dark:text-white outline-none focus:border-primary" />
                <input value={v} onChange={e => { const n = [...envPairs]; n[i] = [k, e.target.value]; setEnvPairs(n); }} placeholder="value"
                  className="flex-1 h-8 px-2 bg-slate-50 dark:bg-black/30 border border-slate-200 dark:border-white/10 rounded text-[10px] font-mono text-slate-800 dark:text-white outline-none focus:border-primary" />
                <button onClick={() => setEnvPairs(envPairs.filter((_, j) => j !== i))} className="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-mac-red">
                  <span className="material-symbols-outlined text-[14px]">remove_circle</span>
                </button>
              </div>
            ))}
            <button onClick={() => setEnvPairs([...envPairs, ['', '']])} className="text-[10px] text-primary font-bold hover:underline">+ Add</button>
          </div>
        </div>
        <div className="px-5 py-3 border-t border-slate-200 dark:border-white/5 flex justify-end gap-2">
          <button onClick={onClose} className="h-8 px-4 text-xs font-bold text-slate-500 hover:text-slate-700 dark:text-white/50 dark:hover:text-white">{sk.cancel}</button>
          <button onClick={handleSave} disabled={saving} className="h-8 px-5 bg-primary text-white text-xs font-bold rounded-lg disabled:opacity-50">
            {saving ? '...' : sk.save}
          </button>
        </div>
      </div>
    </div>
  );
};

// 技能卡片
const SkillCard: React.FC<{
  skill: SkillStatus; config: SkillsConfig; language: Language;
  onConfigure: (skill: SkillStatus) => void;
  onCopyInstall: (skill: SkillStatus) => void;
  onSendInstall: (skill: SkillStatus) => void;
  onToggle: (skill: SkillStatus) => void;
  gwReady: boolean;
  busyKey: string | null;
  message: SkillMessage | null;
  translation?: { name: string; description: string; status: string };
  autoTranslate: boolean;
}> = ({ skill, config, language, onConfigure, onCopyInstall, onSendInstall, onToggle, gwReady, busyKey, message, translation, autoTranslate }) => {
  const sk = (getTranslation(language) as any).sk;
  const showTranslated = autoTranslate && language !== 'en' && translation?.status === 'cached';
  const entry = config[skill.skillKey];
  const isDisabled = entry?.enabled === false || skill.disabled;
  const isBusy = busyKey === skill.skillKey;
  const hasMissing = !skill.eligible && !skill.always;
  const missingBins = skill.missing.bins.length + (skill.missing as any).anyBins?.length || 0;
  const missingEnv = skill.missing.env.length;
  const missingOs = skill.missing.os.length;
  const missingConfig = skill.missing.config.length;

  const unsupportedOs = missingOs > 0;

  return (
    <div className={`bg-slate-50 dark:bg-white/[0.02] border rounded-2xl p-4 transition-all group shadow-sm flex flex-col ${
      isDisabled ? 'border-slate-200/50 dark:border-white/5 opacity-60' :
      unsupportedOs ? 'border-slate-200/50 dark:border-white/5 opacity-40' :
      skill.eligible ? 'border-mac-green/30 dark:border-mac-green/20 hover:border-mac-green/60' :
      'border-slate-200 dark:border-white/10 hover:border-primary/40'
    }`}>
      {/* 头部 */}
      <div className="flex items-center gap-2.5 mb-2">
        <span className="text-lg leading-none">{skill.emoji || '⚙️'}</span>
        <div className="flex-1 min-w-0">
          <h4 className="font-bold text-[13px] text-slate-800 dark:text-white truncate">{showTranslated && translation?.name ? translation.name : skill.name}</h4>
          {translation?.status === 'translating' && <span className="text-[9px] text-primary animate-pulse">{sk.translating}</span>}
        </div>
        {/* 内联 Enable/Disable 开关 */}
        <button onClick={() => onToggle(skill)} disabled={isBusy}
          className={`w-9 h-5 rounded-full transition-colors relative shrink-0 ${isDisabled ? 'bg-slate-300 dark:bg-white/20' : 'bg-mac-green'}`}>
          <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${isDisabled ? 'translate-x-0.5' : 'translate-x-[18px]'}`} />
        </button>
      </div>

      {/* 状态标签行 */}
      <div className="flex flex-wrap gap-1 mb-2">
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 dark:bg-white/5 text-slate-500 dark:text-white/40 font-bold">{skill.source}</span>
        {skill.bundled && skill.source !== 'openclaw-bundled' && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-500/10 text-indigo-500 font-bold">{sk.bundled}</span>
        )}
        {isDisabled ? (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-200 dark:bg-white/10 text-slate-500 font-bold">{sk.disabled}</span>
        ) : skill.eligible ? (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-mac-green/15 text-mac-green font-bold">{sk.eligible}</span>
        ) : (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 dark:bg-amber-500/15 text-amber-600 dark:text-amber-400 font-bold">{sk.notEligible}</span>
        )}
        {skill.blockedByAllowlist && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-mac-red/10 text-mac-red font-bold">{sk.blockedByAllowlist}</span>
        )}
      </div>

      {/* 描述 */}
      <ExpandableDesc text={showTranslated && translation?.description ? translation.description : skill.description} />

      {/* 缺失依赖提示 */}
      {hasMissing && !isDisabled && (
        <div className="mb-3 space-y-1">
          {missingBins > 0 && (
            <div className="flex items-center gap-1.5 text-[10px] text-amber-600 dark:text-amber-400">
              <span className="material-symbols-outlined text-[12px]">terminal</span>
              <span className="truncate">{sk.missingBins}: {[...skill.missing.bins, ...(skill.missing as any).anyBins || []].join(', ')}</span>
            </div>
          )}
          {missingEnv > 0 && (
            <div className="flex items-center gap-1.5 text-[10px] text-amber-600 dark:text-amber-400">
              <span className="material-symbols-outlined text-[12px]">key</span>
              <span className="truncate">{sk.missingEnv}: {skill.missing.env.join(', ')}</span>
            </div>
          )}
          {missingOs > 0 && (
            <div className="flex items-center gap-1.5 text-[10px] text-red-500">
              <span className="material-symbols-outlined text-[12px]">desktop_windows</span>
              <span>{sk.missingOs}</span>
            </div>
          )}
          {missingConfig > 0 && (
            <div className="flex items-center gap-1.5 text-[10px] text-amber-600 dark:text-amber-400">
              <span className="material-symbols-outlined text-[12px]">settings</span>
              <span className="truncate">{sk.missingConfig}: {skill.missing.config.join(', ')}</span>
            </div>
          )}
        </div>
      )}

      {/* Per-skill message */}
      {message && (
        <p className={`text-[11px] font-bold mb-2 ${message.kind === 'error' ? 'text-mac-red' : 'text-mac-green'}`}>{message.message}</p>
      )}

      {/* 操作按钮 */}
      <div className="flex gap-1.5 mt-auto pt-1">
        {hasMissing && !unsupportedOs && (
          gwReady ? (
            <button onClick={() => onSendInstall(skill)}
              className="flex-1 h-7 bg-primary/15 text-primary hover:bg-primary/25 text-[10px] font-bold rounded-lg transition-colors flex items-center justify-center gap-1 truncate">
              <span className="material-symbols-outlined text-[12px]">send</span>
              <span className="truncate">{sk.requestInstall}</span>
            </button>
          ) : (
            <button onClick={() => onCopyInstall(skill)}
              className="flex-1 h-7 bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-white/60 hover:bg-slate-200 dark:hover:bg-white/10 text-[10px] font-bold rounded-lg transition-colors flex items-center justify-center gap-1 truncate">
              <span className="material-symbols-outlined text-[12px]">content_copy</span>
              <span className="truncate">{sk.copyInstallInfo}</span>
            </button>
          )
        )}
        {unsupportedOs && (
          <span className="flex-1 h-7 bg-slate-100 dark:bg-white/5 text-slate-400 dark:text-white/20 text-[10px] font-bold rounded-lg flex items-center justify-center gap-1">
            <span className="material-symbols-outlined text-[12px]">block</span>
            {sk.missingOs}
          </span>
        )}
        <button onClick={() => onConfigure(skill)} className="h-7 px-2.5 bg-white dark:bg-white/10 text-[10px] font-bold rounded-lg border border-slate-200 dark:border-white/5 hover:border-primary/40 transition-colors flex items-center gap-1 shrink-0">
          <span className="material-symbols-outlined text-[12px]">tune</span>
          {sk.configure}
        </button>
        {skill.homepage && (
          <a href={skill.homepage} target="_blank" rel="noopener noreferrer" className="h-7 w-7 flex items-center justify-center bg-white dark:bg-white/10 rounded-lg border border-slate-200 dark:border-white/5 hover:border-primary/40 transition-colors shrink-0">
            <span className="material-symbols-outlined text-[12px] text-slate-400">open_in_new</span>
          </a>
        )}
      </div>
    </div>
  );
};

const Skills: React.FC<SkillsProps> = ({ language }) => {
  const t = useMemo(() => getTranslation(language), [language]);
  const sk = t.sk as any;
  const { toast } = useToast();

  const [activeTab, setActiveTab] = useState<TabId>('all');
  const [filter, setFilter] = useState<FilterId>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [skills, setSkills] = useState<SkillStatus[]>([]);
  const [skillsConfig, setSkillsConfig] = useState<SkillsConfig>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [configSkill, setConfigSkill] = useState<SkillStatus | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [skillMessages, setSkillMessages] = useState<SkillMessageMap>({});
  const [groupView, setGroupView] = useState(false);
  const [canSendToAgent, setCanSendToAgent] = useState(false);

  // 自动翻译开关（默认开启，使用 localStorage 持久化）
  const [autoTranslate, setAutoTranslate] = useState(() => {
    const saved = localStorage.getItem('skills-auto-translate');
    return saved === null ? true : saved === 'true';
  });

  // 技能翻译缓存: skillKey -> { name, description, status }
  const [translations, setTranslations] = useState<Record<string, { name: string; description: string; status: string }>>({});

  const sentinelRef = useRef<HTMLDivElement>(null);

  // ClawHub 市场
  const [marketQuery, setMarketQuery] = useState('');
  const [marketResults, setMarketResults] = useState<any[]>([]);
  const [marketSearching, setMarketSearching] = useState(false);
  const [marketSort, setMarketSort] = useState<'newest' | 'downloads' | 'stars'>('newest');
  const [marketCursor, setMarketCursor] = useState<string | null>(null);
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketLoaded, setMarketLoaded] = useState(false);
  const [marketLoadingMore, setMarketLoadingMore] = useState(false);
  const [marketInstalledSlugs, setMarketInstalledSlugs] = useState<Set<string>>(new Set());

  const fetchSkills = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [statusRes, configRes] = await Promise.all([
        gwApi.skills(),
        gwApi.skillsConfig(),
      ]);
      const statusData = statusRes as any;
      const configData = configRes as any;
      setSkills(statusData?.skills || []);
      setSkillsConfig(configData?.entries || {});
    } catch (e: any) {
      setError(e?.message || sk.loadFailed);
    } finally {
      setLoading(false);
    }
  }, [sk.loadFailed]);

  useEffect(() => { fetchSkills(); }, [fetchSkills]);

  // 检测 Gateway 连接状态 + 是否有可用频道 + 是否配置了模型
  useEffect(() => {
    (async () => {
      try {
        await gwApi.health();
        const [chData, cfgData] = await Promise.all([
          gwApi.channels() as Promise<any>,
          gwApi.configGet() as Promise<any>,
        ]);
        const list = chData?.channels ?? chData?.list ?? (Array.isArray(chData) ? chData : []);
        const active = Array.isArray(list) ? list.filter((ch: any) => ch.connected || ch.running || ch.status === 'connected') : [];
        const providers = cfgData?.models?.providers || {};
        const hasModel = Object.keys(providers).length > 0;
        setCanSendToAgent(active.length > 0 && hasModel);
      } catch {
        setCanSendToAgent(false);
      }
    })();
  }, []);

  // 通用异步翻译批处理：查询缓存 → 触发翻译 → 轮询结果
  const translateBatch = useCallback(async (
    lang: string,
    items: { skill_key: string; name: string; description: string }[],
  ) => {
    if (lang === 'en' || items.length === 0) return;
    
    // 先检查本地 state 缓存，过滤掉已经有缓存的项
    const itemsToCheck = items.filter(item => {
      const existing = translations[item.skill_key];
      return !existing || existing.status !== 'cached';
    });
    
    if (itemsToCheck.length === 0) return; // 全部已缓存，无需请求
    
    try {
      const allKeys = itemsToCheck.map(s => s.skill_key);
      // 1. 查询服务端缓存
      const cached = await skillTranslationApi.get(lang, allKeys) as any;
      const entries: any[] = Array.isArray(cached) ? cached : (cached?.data || []);
      const cachedMap: Record<string, boolean> = {};
      
      // 立即设置已缓存的翻译（无延迟）
      if (entries.length > 0) {
        setTranslations(prev => {
          const next = { ...prev };
          for (const e of entries) {
            if (e.status === 'cached') {
              next[e.skill_key] = { name: e.name, description: e.description, status: 'cached' };
              cachedMap[e.skill_key] = true;
            }
          }
          return next;
        });
      }

      // 2. 收集真正需要翻译的（服务端也没缓存的）
      const needTranslate = itemsToCheck.filter(s => !cachedMap[s.skill_key] && (s.name || s.description));
      if (needTranslate.length === 0) return;

      // 3. 先设置 translating 状态（只针对需要翻译的项）
      setTranslations(prev => {
        const next = { ...prev };
        for (const s of needTranslate) {
          // 只有在没有缓存的情况下才设置 translating
          if (!next[s.skill_key] || next[s.skill_key].status !== 'cached') {
            next[s.skill_key] = { name: '', description: '', status: 'translating' };
          }
        }
        return next;
      });

      // 4. 触发后台翻译
      await skillTranslationApi.translate(lang, needTranslate);

      // 5. 轮询获取翻译结果
      const pendingKeys = needTranslate.map(s => s.skill_key);
      let retries = 0;
      const poll = setInterval(async () => {
        retries++;
        if (retries > 30) { clearInterval(poll); return; }
        try {
          const res = await skillTranslationApi.get(lang, pendingKeys) as any;
          const list: any[] = Array.isArray(res) ? res : (res?.data || []);
          let allDone = true;
          setTranslations(prev => {
            const next = { ...prev };
            for (const e of list) {
              if (e.status === 'cached') {
                next[e.skill_key] = { name: e.name, description: e.description, status: 'cached' };
              } else {
                allDone = false;
              }
            }
            return next;
          });
          if (allDone) clearInterval(poll);
        } catch { /* ignore poll errors */ }
      }, 3000);
    } catch { /* ignore */ }
  }, [translations]);

  // 持久化自动翻译设置
  useEffect(() => {
    localStorage.setItem('skills-auto-translate', String(autoTranslate));
  }, [autoTranslate]);

  // 合并翻译请求：本地技能 + 市场技能，添加防抖避免频繁请求
  useEffect(() => {
    if (!autoTranslate || language === 'en') return;
    
    // 收集所有需要翻译的项
    const allItems: { skill_key: string; name: string; description: string }[] = [];
    
    // 本地技能
    for (const s of skills) {
      allItems.push({ skill_key: s.skillKey, name: s.name || '', description: s.description || '' });
    }
    
    // 市场技能
    for (const item of marketResults) {
      allItems.push({
        skill_key: `market:${(item as any).slug || (item as any).name || ''}`,
        name: (item as any).displayName || (item as any).name || '',
        description: (item as any).summary || (item as any).description || '',
      });
    }
    
    if (allItems.length === 0) return;
    
    // 防抖：500ms 后执行，避免快速连续触发
    const timer = setTimeout(() => {
      // 分批处理：每批最多 15 个，依次处理所有批次
      const batchSize = 15;
      const processBatches = async () => {
        for (let i = 0; i < allItems.length; i += batchSize) {
          const batch = allItems.slice(i, i + batchSize);
          if (batch.length > 0) {
            await translateBatch(language, batch);
          }
        }
      };
      processBatches();
    }, 500);
    
    return () => clearTimeout(timer);
  }, [autoTranslate, language, skills, marketResults, translateBatch]);

  // 复制技能安装信息到剪贴板
  const handleCopyInstall = useCallback((skill: SkillStatus) => {
    const prompt = buildInstallPrompt(skill, sk);
    navigator.clipboard.writeText(prompt).then(() => {
      toast('success', sk.copiedHint);
    }).catch(() => { /* fallback: ignore */ });
  }, [sk, toast]);

  // 一键发送技能安装信息给代理
  const handleSendInstall = useCallback(async (skill: SkillStatus) => {
    const prompt = buildInstallPrompt(skill, sk);
    try {
      await gwApi.proxy('agent', { message: prompt });
      toast('success', sk.sentToAgentHint);
    } catch (err: any) {
      toast('error', (sk.sendFailed || 'Failed') + ': ' + (err?.message || ''));
    }
  }, [sk, toast]);

  // 复制市场技能安装信息到剪贴板
  const handleCopyMarketInstall = useCallback((item: any) => {
    const prompt = buildMarketInstallPrompt(item, sk);
    navigator.clipboard.writeText(prompt).then(() => {
      toast('success', sk.copiedHint);
    }).catch(() => { /* fallback: ignore */ });
  }, [sk, toast]);

  // 一键发送市场技能安装信息给代理
  const handleSendMarketInstall = useCallback(async (item: any) => {
    const prompt = buildMarketInstallPrompt(item, sk);
    try {
      await gwApi.proxy('agent', { message: prompt });
      toast('success', sk.sentToAgentHint);
    } catch (err: any) {
      toast('error', (sk.sendFailed || 'Failed') + ': ' + (err?.message || ''));
    }
  }, [sk, toast]);

  // 过滤技能
  const filteredSkills = useMemo(() => {
    let list = skills;
    // Tab 过滤
    if (activeTab === 'eligible') list = list.filter(s => s.eligible);
    else if (activeTab === 'missing') {
      list = list.filter(s => !s.eligible && !s.always);
      // 排序：可安装的在前，不支持当前系统的在后
      list = [...list].sort((a, b) => {
        const aUnsupported = a.missing.os.length > 0 ? 1 : 0;
        const bUnsupported = b.missing.os.length > 0 ? 1 : 0;
        if (aUnsupported !== bUnsupported) return aUnsupported - bUnsupported;
        // 有安装选项的排前面
        const aInstallable = a.install.length > 0 ? 0 : 1;
        const bInstallable = b.install.length > 0 ? 0 : 1;
        return aInstallable - bInstallable;
      });
    }
    // 搜索过滤
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(s =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.skillKey.toLowerCase().includes(q)
      );
    }
    return list;
  }, [skills, activeTab, searchQuery]);

  const eligibleCount = useMemo(() => skills.filter(s => s.eligible).length, [skills]);
  const missingCount = useMemo(() => skills.filter(s => !s.eligible && !s.always).length, [skills]);

  // 配置保存
  const handleConfigSave = useCallback(async (skillKey: string, data: { enabled?: boolean; apiKey?: string; env?: Record<string, string> }) => {
    await gwApi.skillsConfigure({ skillKey, ...data });
    const configRes = await gwApi.skillsConfig() as any;
    setSkillsConfig(configRes?.entries || {});
  }, []);

  // 内联 Enable/Disable
  const handleToggle = useCallback(async (skill: SkillStatus) => {
    setBusyKey(skill.skillKey);
    try {
      await gwApi.skillsUpdate({ skillKey: skill.skillKey, enabled: skill.disabled });
      await fetchSkills();
      setSkillMessages(prev => ({ ...prev, [skill.skillKey]: { kind: 'success', message: skill.disabled ? sk.skillEnabled : sk.skillDisabled } }));
    } catch (e: any) {
      setSkillMessages(prev => ({ ...prev, [skill.skillKey]: { kind: 'error', message: String(e) } }));
    }
    setBusyKey(null);
  }, [fetchSkills, sk]);

  const skillGroups = useMemo(() => groupSkills(filteredSkills, sk), [filteredSkills, sk]);

  // ClawHub 列表加载
  const fetchMarketList = useCallback(async (sort: string, cursor?: string, append = false) => {
    if (append) setMarketLoadingMore(true); else setMarketLoading(true);
    try {
      const res = await clawHubApi.list(sort, 20, cursor || undefined) as any;
      const items = res?.items || [];
      setMarketResults(prev => append ? [...prev, ...items] : items);
      setMarketCursor(res?.nextCursor || null);
      setMarketLoaded(true);
    } catch { if (!append) setMarketResults([]); }
    finally { setMarketLoading(false); setMarketLoadingMore(false); }
  }, []);

  // 切换到市场 Tab 时自动加载
  useEffect(() => {
    if (activeTab === 'market' && !marketLoaded && !marketQuery.trim()) {
      fetchMarketList(marketSort);
    }
  }, [activeTab, marketLoaded, marketSort, marketQuery, fetchMarketList]);

  // 切换排序
  const handleSortChange = useCallback((sort: 'newest' | 'downloads' | 'stars') => {
    setMarketSort(sort);
    setMarketQuery('');
    setMarketResults([]);
    setMarketCursor(null);
    setMarketLoaded(false);
    fetchMarketList(sort);
  }, [fetchMarketList]);

  // ClawHub 搜索
  const handleMarketSearch = useCallback(async () => {
    if (!marketQuery.trim()) {
      // 清空搜索时回到列表模式
      setMarketResults([]);
      setMarketLoaded(false);
      fetchMarketList(marketSort);
      return;
    }
    setMarketSearching(true);
    try {
      const res = await clawHubApi.search(marketQuery) as any;
      const items = Array.isArray(res) ? res : (res?.results || res?.skills || res?.data || res?.items || []);
      setMarketResults(Array.isArray(items) ? items : []);
      setMarketCursor(null);
    } catch { setMarketResults([]); }
    finally { setMarketSearching(false); }
  }, [marketQuery, marketSort, fetchMarketList]);

  // 瀑布流自动加载更多
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !marketCursor || marketQuery || marketLoadingMore) return;
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && marketCursor && !marketLoadingMore) {
        fetchMarketList(marketSort, marketCursor, true);
      }
    }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [marketCursor, marketQuery, marketLoadingMore, marketSort, fetchMarketList]);

  const tabs: { id: TabId; label: string; count?: number }[] = [
    { id: 'all', label: sk.allSkills, count: skills.length },
    { id: 'eligible', label: sk.onlyEligible, count: eligibleCount },
    { id: 'missing', label: sk.onlyMissing, count: missingCount },
    { id: 'market', label: sk.marketplace },
  ];

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-white dark:bg-[#0f1115]">
      {/* 顶部工具栏 */}
      <div className="flex flex-col border-b border-slate-200 dark:border-white/5 bg-slate-50 dark:bg-black/20 shrink-0">
        {/* 标签页 */}
        <div className="h-12 flex items-center justify-center px-4 border-b border-slate-200/50 dark:border-white/5">
          <div className="flex bg-slate-200 dark:bg-black/40 p-0.5 rounded-xl shadow-inner">
            {tabs.map(tab => (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-1.5 rounded-lg text-[11px] font-bold transition-all flex items-center gap-1.5 ${
                  activeTab === tab.id ? 'bg-white dark:bg-primary shadow-sm text-slate-900 dark:text-white' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                }`}>
                {tab.label}
                {tab.count !== undefined && <span className="text-[11px] opacity-60">{tab.count}</span>}
              </button>
            ))}
          </div>
        </div>

        {/* 搜索栏 */}
        <div className="p-3 flex flex-row items-center gap-2">
          {activeTab !== 'market' ? (
            <>
              <div className="relative flex-1 min-w-0">
                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-[16px]">search</span>
                <input className="w-full h-9 pl-9 pr-4 bg-white dark:bg-[#1a1c22] border border-slate-200 dark:border-white/10 rounded-lg text-xs text-slate-800 dark:text-white placeholder:text-slate-400 focus:ring-1 focus:ring-primary outline-none"
                  placeholder={sk.search} value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
              </div>
              {/* 自动翻译开关 + 进度 + 刷新 */}
              {language !== 'en' && (
                <div className="flex items-center gap-1.5 shrink-0">
                  <button onClick={() => setAutoTranslate(!autoTranslate)} 
                    className={`h-9 px-3 flex items-center gap-1.5 border rounded-lg text-[11px] font-bold transition-all ${
                      autoTranslate 
                        ? 'bg-primary/10 dark:bg-primary/20 border-primary/30 text-primary hover:bg-primary/20' 
                        : 'bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-500/20'
                    }`}
                    title={autoTranslate ? sk.autoTranslateOn : sk.autoTranslateOff}>
                    <span className="material-symbols-outlined text-[16px]">{autoTranslate ? 'translate' : 'translate_off'}</span>
                    {sk.autoTranslate}
                  </button>
                  {/* 翻译进度指示 */}
                  {autoTranslate && (() => {
                    const total = skills.length + marketResults.length;
                    const translating = Object.values(translations).filter(t => t.status === 'translating').length;
                    const cached = Object.values(translations).filter(t => t.status === 'cached').length;
                    if (translating > 0) {
                      return (
                        <span className="h-9 px-2 flex items-center gap-1 text-[10px] text-primary bg-primary/5 border border-primary/20 rounded-lg">
                          <span className="material-symbols-outlined text-[14px] animate-spin">progress_activity</span>
                          {translating}/{total}
                        </span>
                      );
                    }
                    if (cached > 0 && cached < total) {
                      return (
                        <span className="h-9 px-2 flex items-center gap-1 text-[10px] text-slate-500 dark:text-white/50 bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg">
                          {cached}/{total}
                        </span>
                      );
                    }
                    return null;
                  })()}
                  {/* 刷新翻译按钮 */}
                  {autoTranslate && (
                    <button 
                      onClick={() => {
                        setTranslations({}); // 清空缓存，触发重新翻译
                      }}
                      className="h-9 w-9 flex items-center justify-center bg-slate-100 dark:bg-white/5 hover:bg-slate-200 dark:hover:bg-white/10 border border-slate-200 dark:border-white/10 rounded-lg"
                      title={sk.refreshTranslation || 'Refresh translations'}>
                      <span className="material-symbols-outlined text-[16px] text-slate-500">refresh</span>
                    </button>
                  )}
                </div>
              )}
              <button onClick={() => setGroupView(!groupView)} className="h-9 w-9 flex items-center justify-center bg-slate-100 dark:bg-white/5 hover:bg-slate-200 dark:hover:bg-white/10 border border-slate-200 dark:border-white/10 rounded-lg shrink-0" title={groupView ? 'Flat view' : 'Grouped view'}>
                <span className="material-symbols-outlined text-[16px] text-slate-500">{groupView ? 'view_list' : 'folder'}</span>
              </button>
              <button onClick={() => { fetchSkills(); setSkillMessages({}); }} className="h-9 px-3 flex items-center gap-1.5 bg-slate-100 dark:bg-white/5 hover:bg-slate-200 dark:hover:bg-white/10 border border-slate-200 dark:border-white/10 rounded-lg text-[11px] font-bold text-slate-600 dark:text-white/70 shrink-0">
                <span className={`material-symbols-outlined text-[16px] ${loading ? 'animate-spin' : ''}`}>{loading ? 'progress_activity' : 'refresh'}</span>
                {sk.refresh}
              </button>
            </>
          ) : (
            <>
              <div className="relative flex-1 min-w-0">
                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-[16px]">search</span>
                <input className="w-full h-9 pl-9 pr-4 bg-white dark:bg-[#1a1c22] border border-slate-200 dark:border-white/10 rounded-lg text-xs text-slate-800 dark:text-white placeholder:text-slate-400 focus:ring-1 focus:ring-primary outline-none"
                  placeholder={sk.searchMarket} value={marketQuery} onChange={e => setMarketQuery(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleMarketSearch()} />
              </div>
              <button onClick={handleMarketSearch} disabled={marketSearching} className="h-9 px-3 bg-primary text-white text-[11px] font-bold rounded-lg disabled:opacity-50 shrink-0 whitespace-nowrap">
                {marketSearching ? sk.searching : sk.search}
              </button>
              {/* 排序按钮组 */}
              <div className="flex bg-slate-200 dark:bg-black/40 p-0.5 rounded-lg shadow-inner shrink-0">
                {([['newest', sk.sortNewest], ['downloads', sk.sortDownloads], ['stars', sk.sortStars]] as const).map(([val, label]) => (
                  <button key={val} onClick={() => handleSortChange(val as any)}
                    className={`px-2 py-1 rounded text-[10px] font-bold transition-all whitespace-nowrap ${marketSort === val ? 'bg-white dark:bg-primary shadow-sm text-slate-900 dark:text-white' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}>
                    {label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto p-4 md:p-6 custom-scrollbar">
        <div className="max-w-6xl mx-auto">
          {/* 加载/错误状态 */}
          {activeTab !== 'market' && loading && (
            <div className="flex flex-col items-center justify-center py-20 text-slate-400">
              <span className="material-symbols-outlined text-4xl animate-spin mb-3">progress_activity</span>
              <span className="text-xs">{sk.loadFailed === error ? sk.loadFailed : 'Loading...'}</span>
            </div>
          )}
          {activeTab !== 'market' && error && !loading && (
            <div className="flex flex-col items-center justify-center py-20 text-slate-400">
              <span className="material-symbols-outlined text-4xl mb-3 text-mac-red">error</span>
              <span className="text-xs mb-3">{error}</span>
              <button onClick={fetchSkills} className="h-8 px-4 bg-primary text-white text-xs font-bold rounded-lg">{sk.retry}</button>
            </div>
          )}

          {/* 技能网格 */}
          {activeTab !== 'market' && !loading && !error && (
            <>
              {filteredSkills.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 text-slate-400">
                  <span className="material-symbols-outlined text-4xl mb-3">extension_off</span>
                  <span className="text-xs">{sk.noSkills}</span>
                </div>
              ) : groupView && skillGroups.length >= 1 ? (
                <div className="space-y-4">
                  {skillGroups.map(group => (
                    <details key={group.id} open={group.id !== 'workspace' && group.id !== 'builtIn'}>
                      <summary className="flex items-center gap-2 cursor-pointer select-none mb-2 group/sum">
                        <span className="material-symbols-outlined text-[14px] text-slate-400 group-open/sum:rotate-90 transition-transform">chevron_right</span>
                        <span className="text-[11px] font-bold text-slate-600 dark:text-white/60 uppercase tracking-wider">{group.label}</span>
                        <span className="text-[11px] text-slate-400 dark:text-white/35">{group.skills.length}</span>
                      </summary>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                        {group.skills.map(skill => (
                          <SkillCard key={skill.skillKey} skill={skill} config={skillsConfig} language={language}
                            onConfigure={setConfigSkill} onCopyInstall={handleCopyInstall} onSendInstall={handleSendInstall} onToggle={handleToggle}
                            gwReady={canSendToAgent} busyKey={busyKey} message={skillMessages[skill.skillKey] || null}
                            translation={translations[skill.skillKey]} autoTranslate={autoTranslate} />
                        ))}
                      </div>
                    </details>
                  ))}
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {filteredSkills.map(skill => (
                    <SkillCard key={skill.skillKey} skill={skill} config={skillsConfig} language={language}
                      onConfigure={setConfigSkill} onCopyInstall={handleCopyInstall} onSendInstall={handleSendInstall} onToggle={handleToggle}
                      gwReady={canSendToAgent} busyKey={busyKey} message={skillMessages[skill.skillKey] || null}
                      translation={translations[skill.skillKey]} autoTranslate={autoTranslate} />
                  ))}
                </div>
              )}
            </>
          )}

          {/* ClawHub 市场 */}
          {activeTab === 'market' && (
            <div className="space-y-4">
              {/* 加载中 */}
              {(marketLoading || marketSearching) && marketResults.length === 0 && (
                <div className="flex items-center justify-center py-16 text-slate-400">
                  <span className="material-symbols-outlined text-3xl animate-spin mr-2">progress_activity</span>
                  <span className="text-xs">{marketSearching ? sk.searching : 'Loading...'}</span>
                </div>
              )}
              {/* 搜索无结果 */}
              {!marketSearching && !marketLoading && marketResults.length === 0 && marketQuery && (
                <div className="flex flex-col items-center justify-center py-16 text-slate-400">
                  <span className="material-symbols-outlined text-4xl mb-3">search_off</span>
                  <span className="text-xs">{sk.noResults}</span>
                </div>
              )}
              {/* 列表无数据 */}
              {!marketSearching && !marketLoading && marketResults.length === 0 && !marketQuery && marketLoaded && (
                <div className="flex flex-col items-center justify-center py-16 text-slate-400">
                  <span className="material-symbols-outlined text-5xl mb-4 text-primary/30">store</span>
                  <span className="text-sm font-bold mb-1 text-slate-600 dark:text-white/50">{sk.noMarketData}</span>
                </div>
              )}
              {/* 技能卡片列表 */}
              {marketResults.length > 0 && (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {marketResults.map((item: any, i: number) => {
                      const slug = item.slug || item.name || `item-${i}`;
                      const marketKey = `market:${slug}`;
                      const mTrans = translations[marketKey];
                      const mTransReady = autoTranslate && language !== 'en' && mTrans?.status === 'cached';
                      const stats = item.stats || {};
                      const ver = item.latestVersion?.version || item.tags?.latest || '';
                      return (
                        <div key={slug + '-' + i} className="bg-slate-50 dark:bg-white/[0.02] border border-slate-200 dark:border-white/5 rounded-2xl p-4 hover:border-primary/30 transition-all group shadow-sm flex flex-col">
                          {/* 头部 */}
                          <div className="flex items-start gap-3 mb-2">
                            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary/15 to-purple-500/15 flex items-center justify-center shrink-0 border border-slate-200/50 dark:border-white/5">
                              <span className="text-lg">{item.emoji || '📦'}</span>
                            </div>
                            <div className="flex-1 min-w-0">
                              <h4 className="font-bold text-[13px] text-slate-800 dark:text-white truncate">{mTransReady && mTrans?.name ? mTrans.name : (item.displayName || item.name || slug)}</h4>
                              {mTrans?.status === 'translating' && <span className="text-[10px] text-primary animate-pulse">{sk.translating}</span>}
                              {ver && <span className="text-[11px] font-mono text-slate-400 dark:text-white/40">v{ver}</span>}
                            </div>
                            {(() => {
                              const isInstalled = marketInstalledSlugs.has(slug) || skills.some(s => s.skillKey.toLowerCase().includes(slug.toLowerCase()) || s.name.toLowerCase().includes(slug.toLowerCase()));
                              if (isInstalled) return (
                                <span className="h-7 px-3 bg-mac-green/10 text-mac-green text-[10px] font-bold rounded-lg flex items-center gap-1 shrink-0">
                                  <span className="material-symbols-outlined text-[12px]">check_circle</span>
                                  {sk.installed}
                                </span>
                              );
                              return canSendToAgent ? (
                                <button onClick={() => handleSendMarketInstall(item)}
                                  className="h-7 px-3 bg-primary/10 dark:bg-primary/20 hover:bg-primary text-primary hover:text-white text-[10px] font-bold rounded-lg transition-all shrink-0 flex items-center gap-1">
                                  <span className="material-symbols-outlined text-[12px]">send</span>
                                  {sk.requestInstall}
                                </button>
                              ) : (
                                <button onClick={() => handleCopyMarketInstall(item)}
                                  className="h-7 px-3 bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-white/60 hover:bg-slate-200 dark:hover:bg-white/10 text-[10px] font-bold rounded-lg transition-all shrink-0 flex items-center gap-1">
                                  <span className="material-symbols-outlined text-[12px]">content_copy</span>
                                  {sk.copyInstallInfo}
                                </button>
                              );
                            })()}
                          </div>
                          {/* 描述 */}
                          <ExpandableDesc text={mTransReady && mTrans?.description ? mTrans.description : (item.summary || item.description || '')} />
                          {/* 统计 + 链接 */}
                          <div className="flex items-center gap-3 mt-auto text-[11px] text-slate-400 dark:text-white/35">
                            {stats.downloads > 0 && (
                              <span className="flex items-center gap-0.5">
                                <span className="material-symbols-outlined text-[11px]">download</span>
                                {stats.downloads.toLocaleString()}
                              </span>
                            )}
                            {stats.stars > 0 && (
                              <span className="flex items-center gap-0.5">
                                <span className="material-symbols-outlined text-[11px]">star</span>
                                {stats.stars}
                              </span>
                            )}
                            {stats.versions > 0 && (
                              <span className="flex items-center gap-0.5">
                                <span className="material-symbols-outlined text-[11px]">history</span>
                                {stats.versions} {sk.versions}
                              </span>
                            )}
                            {item.createdAt && (
                              <span className="text-[11px]">
                                {new Date(item.createdAt).toLocaleDateString()}
                              </span>
                            )}
                            {/* 链接跳转 */}
                            <a href={`https://clawhub.ai/skills/${encodeURIComponent(slug)}`} target="_blank" rel="noopener noreferrer"
                              className="ml-auto flex items-center gap-0.5 text-primary/60 hover:text-primary transition-colors">
                              <span className="material-symbols-outlined text-[11px]">open_in_new</span>
                              {sk.homepage}
                            </a>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {/* 瀑布流加载更多 */}
                  {marketCursor && !marketQuery && (
                    <div className="flex justify-center py-6">
                      {marketLoadingMore ? (
                        <span className="material-symbols-outlined text-2xl animate-spin text-primary/40">progress_activity</span>
                      ) : (
                        <div ref={sentinelRef} className="h-1" />
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 底部状态栏 */}
      <footer className="h-8 px-4 border-t border-slate-200 dark:border-white/5 bg-slate-50 dark:bg-black/20 flex items-center justify-between shrink-0 text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-white/20">
        <div className="flex items-center gap-3">
          <span>{skills.length} {sk.skillCount}</span>
          <span className="w-1 h-1 rounded-full bg-slate-200 dark:bg-white/10" />
          <span className="text-mac-green">{eligibleCount} {sk.eligibleCount}</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="material-symbols-outlined text-[12px]">verified_user</span>
          <span>{sk.bundled}: {skills.filter(s => s.bundled).length}</span>
        </div>
      </footer>

      {/* 配置弹窗 */}
      {configSkill && (
        <ConfigModal skill={configSkill} config={skillsConfig} language={language} onSave={handleConfigSave} onClose={() => setConfigSkill(null)} />
      )}
    </div>
  );
};

export default Skills;
