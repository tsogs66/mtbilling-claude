import { useEffect, useState } from 'react';
import {
  Bot, Settings2, Sparkles, Copy, Trash2, CheckCircle2, Loader2,
  ExternalLink, History, Zap,
} from 'lucide-react';
import Layout from '../components/Layout';
import { Card, Flash, LoadingPage, PageHeader, StatusBadge, TabBar } from '../components/ui';
import { api } from '../api';
import { copyText } from '../lib/clipboard';

const TABS = [
  { key: 'setup', label: 'Setup', icon: Settings2 },
  { key: 'generate', label: 'Generate Script', icon: Sparkles },
  { key: 'history', label: 'History', icon: History },
] as const;

type AiConfig = {
  ai_enabled: boolean;
  ai_provider: string;
  ai_model: string;
  cursor_model: string;
  cursor_repo_url: string;
  ai_api_key_set: boolean;
  cursor_api_key_set: boolean;
  claude_models: { id: string; label: string }[];
  cursor_models: { id: string; label: string }[];
  templates: { id: string; title: string; prompt: string }[];
};

export default function AiScripting() {
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('setup');
  const [cfg, setCfg] = useState<AiConfig | null>(null);
  const [banner, setBanner] = useState('');
  const [error, setError] = useState('');

  const load = () => api.get('/ai/config').then((r) => setCfg(r.data));
  useEffect(() => {
    load();
  }, []);

  const flash = (m: string, isErr = false) => {
    if (isErr) {
      setError(m);
      setBanner('');
    } else {
      setBanner(m);
      setError('');
    }
    setTimeout(() => {
      setBanner('');
      setError('');
    }, 5000);
  };

  if (!cfg) {
    return (
      <Layout title="AI Scripting">
        <LoadingPage label="Loading AI configuration…" />
      </Layout>
    );
  }

  return (
    <Layout title="AI Scripting">
      <PageHeader
        title="AI Scripting"
        icon={Bot}
        description="Generate MikroTik RouterOS scripts with Claude (Anthropic) for instant results, or launch Cursor Cloud Agents for complex repo-based automation."
      />

      <Flash message={banner} type="success" />
      <Flash message={error} type="error" />

      <TabBar tabs={[...TABS]} active={tab} onChange={(k) => setTab(k as (typeof TABS)[number]['key'])} className="mb-5" />

      {tab === 'setup' && <SetupTab cfg={cfg} setCfg={setCfg} flash={flash} onSaved={load} />}
      {tab === 'generate' && <GenerateTab cfg={cfg} flash={flash} />}
      {tab === 'history' && <HistoryTab flash={flash} />}
    </Layout>
  );
}

function SetupTab({
  cfg,
  setCfg,
  flash,
  onSaved,
}: {
  cfg: AiConfig;
  setCfg: (c: AiConfig) => void;
  flash: (m: string, isErr?: boolean) => void;
  onSaved: () => void;
}) {
  const [claudeKey, setClaudeKey] = useState('');
  const [cursorKey, setCursorKey] = useState('');
  const [testing, setTesting] = useState<'claude' | 'cursor' | null>(null);
  const [saving, setSaving] = useState(false);

  const patch = (p: Partial<AiConfig>) => setCfg({ ...cfg, ...p });

  const save = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        ai_enabled: cfg.ai_enabled,
        ai_provider: cfg.ai_provider,
        ai_model: cfg.ai_model,
        cursor_model: cfg.cursor_model,
        cursor_repo_url: cfg.cursor_repo_url,
      };
      if (claudeKey) body.ai_api_key = claudeKey;
      if (cursorKey) body.cursor_api_key = cursorKey;
      const r = await api.put('/ai/config', body);
      setCfg(r.data);
      setClaudeKey('');
      setCursorKey('');
      flash('AI integration settings saved.');
      onSaved();
    } catch (e: any) {
      flash(e?.response?.data?.error || 'Save failed.', true);
    } finally {
      setSaving(false);
    }
  };

  const test = async (provider: 'claude' | 'cursor') => {
    setTesting(provider);
    try {
      const r = await api.post('/ai/test', {
        provider: provider === 'claude' ? 'anthropic' : 'cursor',
        api_key: provider === 'claude' ? claudeKey || undefined : cursorKey || undefined,
      });
      flash(r.data.message || 'Connection successful.');
    } catch (e: any) {
      flash(e?.response?.data?.error || 'Test failed.', true);
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="space-y-5 max-w-4xl">
      <Card interactive>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="font-semibold text-slate-800 flex items-center gap-2">
              <Bot size={18} className="text-brand-500" /> AI Scripting assistant
            </div>
            <p className="text-sm text-slate-500 mt-1">Enable script generation from the Generate tab.</p>
          </div>
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
            <input
              type="checkbox"
              className="w-4 h-4"
              checked={cfg.ai_enabled}
              onChange={(e) => patch({ ai_enabled: e.target.checked })}
            />
            Enabled
          </label>
        </div>
      </Card>

      <Card title="Claude API (Anthropic)">
        <div className="space-y-4">
          <p className="text-sm text-slate-500">
            Best for instant RouterOS script generation. Get an API key from{' '}
            <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" className="text-brand-600 hover:underline inline-flex items-center gap-0.5">
              Anthropic Console <ExternalLink size={12} />
            </a>
            {' '}(separate from a claude.ai Pro subscription).
          </p>
          <div className="flex items-center gap-2 text-sm">
            <StatusBadge status={cfg.ai_api_key_set ? 'active' : 'offline'} />
            <span className="text-slate-500">{cfg.ai_api_key_set ? 'API key configured' : 'No API key saved'}</span>
          </div>
          <label className="block">
            <span className="text-sm font-semibold text-slate-700 mb-1 block">API Key</span>
            <input
              className="input font-mono text-sm"
              type="password"
              placeholder={cfg.ai_api_key_set ? '••••••• (leave blank to keep)' : 'sk-ant-api03-...'}
              value={claudeKey}
              onChange={(e) => setClaudeKey(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="text-sm font-semibold text-slate-700 mb-1 block">Default model</span>
            <select className="input" value={cfg.ai_model} onChange={(e) => patch({ ai_model: e.target.value })}>
              {cfg.claude_models.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </label>
          <div className="flex justify-end gap-2">
            <button
              className="inline-flex items-center gap-1.5 text-sm border border-slate-200 rounded-lg px-3 py-2 hover:bg-slate-50 text-slate-600 disabled:opacity-50"
              onClick={() => test('claude')}
              disabled={testing === 'claude' || (!claudeKey && !cfg.ai_api_key_set)}
            >
              {testing === 'claude' ? <Loader2 size={15} className="animate-spin" /> : <Zap size={15} />}
              Test connection
            </button>
          </div>
        </div>
      </Card>

      <Card title="Cursor API (Cloud Agents)">
        <div className="space-y-4">
          <p className="text-sm text-slate-500">
            Launch Cursor Cloud Agents for complex, repo-based MikroTik automation. Create a key at{' '}
            <a href="https://cursor.com/dashboard?tab=integrations" target="_blank" rel="noreferrer" className="text-brand-600 hover:underline inline-flex items-center gap-0.5">
              Cursor Dashboard → API Keys <ExternalLink size={12} />
            </a>
            . Keys start with <code className="text-xs bg-slate-100 px-1 rounded">crsr_</code>.
          </p>
          <div className="flex items-center gap-2 text-sm">
            <StatusBadge status={cfg.cursor_api_key_set ? 'active' : 'offline'} />
            <span className="text-slate-500">{cfg.cursor_api_key_set ? 'API key configured' : 'No API key saved'}</span>
          </div>
          <label className="block">
            <span className="text-sm font-semibold text-slate-700 mb-1 block">API Key</span>
            <input
              className="input font-mono text-sm"
              type="password"
              placeholder={cfg.cursor_api_key_set ? '••••••• (leave blank to keep)' : 'crsr_...'}
              value={cursorKey}
              onChange={(e) => setCursorKey(e.target.value)}
            />
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="block">
              <span className="text-sm font-semibold text-slate-700 mb-1 block">Agent model</span>
              <select className="input" value={cfg.cursor_model} onChange={(e) => patch({ cursor_model: e.target.value })}>
                {cfg.cursor_models.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </label>
            <label className="block sm:col-span-1">
              <span className="text-sm font-semibold text-slate-700 mb-1 block">Git repository URL</span>
              <input
                className="input text-sm"
                placeholder="https://github.com/org/mikrotik-configs"
                value={cfg.cursor_repo_url || ''}
                onChange={(e) => patch({ cursor_repo_url: e.target.value })}
              />
            </label>
          </div>
          <div className="rounded-lg bg-sky-50 border border-sky-100 px-4 py-3 text-xs text-sky-800">
            Cursor agents work on a connected Git repo. For one-off RouterOS scripts, use Claude above. Cursor is ideal when scripts live in version control and need PR-based deployment.
          </div>
          <div className="flex justify-end gap-2">
            <button
              className="inline-flex items-center gap-1.5 text-sm border border-slate-200 rounded-lg px-3 py-2 hover:bg-slate-50 text-slate-600 disabled:opacity-50"
              onClick={() => test('cursor')}
              disabled={testing === 'cursor' || (!cursorKey && !cfg.cursor_api_key_set)}
            >
              {testing === 'cursor' ? <Loader2 size={15} className="animate-spin" /> : <Zap size={15} />}
              Test connection
            </button>
          </div>
        </div>
      </Card>

      <Card title="Default provider for generation">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[
            ['anthropic', 'Claude (Anthropic)', 'Instant RouterOS scripts via Messages API'],
            ['cursor', 'Cursor Cloud Agents', 'Repo-based agent tasks with auto-PR'],
          ].map(([id, title, desc]) => (
            <button
              key={id}
              type="button"
              onClick={() => patch({ ai_provider: id })}
              className={`text-left rounded-lg border p-4 transition-colors ${
                cfg.ai_provider === id ? 'border-brand-500 bg-brand-50/50 ring-1 ring-brand-200' : 'border-slate-200 hover:border-slate-300'
              }`}
            >
              <div className="font-medium text-slate-800">{title}</div>
              <div className="text-xs text-slate-500 mt-1">{desc}</div>
            </button>
          ))}
        </div>
      </Card>

      <div className="flex justify-end">
        <button className="btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save integration settings'}
        </button>
      </div>
    </div>
  );
}

function GenerateTab({ cfg, flash }: { cfg: AiConfig; flash: (m: string, isErr?: boolean) => void }) {
  const [prompt, setPrompt] = useState('');
  const [provider, setProvider] = useState(cfg.ai_provider || 'anthropic');
  const [routerId, setRouterId] = useState<number | ''>('');
  const [routers, setRouters] = useState<any[]>([]);
  const [script, setScript] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.get('/routers').then((r) => setRouters(r.data));
  }, []);
  useEffect(() => {
    setProvider(cfg.ai_provider || 'anthropic');
  }, [cfg.ai_provider]);

  const generate = async () => {
    if (!cfg.ai_enabled) {
      flash('Enable AI Scripting in the Setup tab first.', true);
      return;
    }
    if (!prompt.trim()) {
      flash('Enter a prompt or pick a template.', true);
      return;
    }
    setBusy(true);
    setScript('');
    try {
      const r = await api.post('/ai/generate', {
        prompt,
        provider,
        router_id: routerId || undefined,
      });
      setScript(r.data.script);
      if (r.data.agent) {
        flash(`Cursor agent launched. Track at cursor.com/agents`);
      } else {
        flash('Script generated.');
      }
    } catch (e: any) {
      flash(e?.response?.data?.error || 'Generation failed.', true);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    const ok = await copyText(script);
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
      <div className="space-y-4">
        <Card title="Prompt">
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {cfg.templates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="text-xs px-2.5 py-1 rounded-full border border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-brand-300"
                  onClick={() => setPrompt(t.prompt)}
                >
                  {t.title}
                </button>
              ))}
            </div>
            <textarea
              className="input min-h-[160px] font-mono text-sm"
              placeholder="Describe the RouterOS script you need…"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block">
                <span className="text-sm text-slate-600 mb-1 block">Provider</span>
                <select className="input" value={provider} onChange={(e) => setProvider(e.target.value)}>
                  <option value="anthropic">Claude (Anthropic)</option>
                  <option value="cursor">Cursor Cloud Agent</option>
                </select>
              </label>
              <label className="block">
                <span className="text-sm text-slate-600 mb-1 block">Target router (optional)</span>
                <select className="input" value={routerId} onChange={(e) => setRouterId(e.target.value ? Number(e.target.value) : '')}>
                  <option value="">— Any / generic —</option>
                  {routers.map((r) => (
                    <option key={r.id} value={r.id}>{r.name} ({r.host})</option>
                  ))}
                </select>
              </label>
            </div>
            <button className="btn-primary w-full flex items-center justify-center gap-2" onClick={generate} disabled={busy}>
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
              {busy ? 'Generating…' : 'Generate script'}
            </button>
          </div>
        </Card>
      </div>

      <Card
        title="Output"
        right={
          script ? (
            <button
              className="text-sm text-brand-600 hover:text-brand-700 flex items-center gap-1"
              onClick={copy}
            >
              {copied ? <CheckCircle2 size={15} /> : <Copy size={15} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          ) : null
        }
      >
        {script ? (
          <pre className="text-xs font-mono bg-slate-900 text-slate-100 rounded-lg p-4 overflow-auto max-h-[420px] whitespace-pre-wrap">{script}</pre>
        ) : (
          <div className="text-center text-slate-400 py-16 text-sm">
            Generated RouterOS script will appear here.
          </div>
        )}
      </Card>
    </div>
  );
}

function HistoryTab({ flash }: { flash: (m: string, isErr?: boolean) => void }) {
  const [rows, setRows] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);

  const load = () => api.get('/ai/history').then((r) => setRows(r.data));
  useEffect(() => {
    load();
  }, []);

  const del = async (id: number) => {
    await api.delete(`/ai/history/${id}`);
    if (selected?.id === id) setSelected(null);
    load();
    flash('Removed from history.');
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
      <Card title="Recent generations">
        {rows.length === 0 ? (
          <div className="text-center text-slate-400 py-8 text-sm">No scripts generated yet.</div>
        ) : (
          <div className="divide-y divide-slate-100 -mx-5 -my-5">
            {rows.map((r) => (
              <button
                key={r.id}
                type="button"
                className={`w-full text-left px-5 py-3 hover:bg-slate-50 flex items-start justify-between gap-3 ${selected?.id === r.id ? 'bg-brand-50/40' : ''}`}
                onClick={() => setSelected(r)}
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-800 truncate">{r.prompt}</div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    {r.provider} · {r.model} · {new Date(r.created_at).toLocaleString()}
                    {r.router_name ? ` · ${r.router_name}` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  className="text-slate-400 hover:text-rose-600 shrink-0"
                  onClick={(e) => {
                    e.stopPropagation();
                    del(r.id);
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </button>
            ))}
          </div>
        )}
      </Card>

      <Card title="Script preview">
        {selected ? (
          <pre className="text-xs font-mono bg-slate-900 text-slate-100 rounded-lg p-4 overflow-auto max-h-[420px] whitespace-pre-wrap">{selected.script}</pre>
        ) : (
          <div className="text-center text-slate-400 py-16 text-sm">Select a history item to preview.</div>
        )}
      </Card>
    </div>
  );
}
