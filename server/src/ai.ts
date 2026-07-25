import express from 'express';
import { db } from './db.js';

export const aiRouter = express.Router();

const ROUTEROS_SYSTEM = `You are a MikroTik RouterOS v7 expert for WISP / fiber ISP operations.
Generate only valid RouterOS CLI script commands (one per line or logical blocks).
Use /ip, /interface, /queue, /ppp, /tool, /system as appropriate.
Add brief # comments for each section. No markdown fences unless the user asks.
Prefer idempotent scripts and warn about destructive commands.`;

const CLAUDE_MODELS = [
  { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
  { id: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
  { id: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku' },
];

const CURSOR_MODELS = [
  { id: 'composer-2', label: 'Composer 2' },
  { id: 'claude-4-sonnet', label: 'Claude 4 Sonnet (via Cursor)' },
];

const TEMPLATES = [
  { id: 'pppoe-queue', title: 'PPPoE queue tree', prompt: 'Create a RouterOS queue tree for PPPoE subscribers with parent download/upload shaping per profile (15M, 25M, 50M).' },
  { id: 'firewall-basic', title: 'Basic firewall', prompt: 'Write a secure MikroTik firewall for a PPPoE NAS: allow established, drop invalid, protect router, allow LAN management.' },
  { id: 'hotspot-voucher', title: 'Hotspot vouchers', prompt: 'Script to add hotspot user profiles for 1 hour, 1 day, and 7 days vouchers with rate limits.' },
  { id: 'backup-export', title: 'Config backup', prompt: 'RouterOS script to export configuration and email or upload backup (use /export and /tool e-mail or FTP placeholders).' },
  { id: 'monitor-script', title: 'Interface monitor', prompt: 'Create a RouterOS scheduler script that logs interface traffic every 5 minutes for the WAN port.' },
];

function getApp(): Record<string, unknown> {
  return db.prepare('SELECT * FROM app_settings WHERE id = 1').get() as Record<string, unknown>;
}

function publicConfig() {
  const s = getApp();
  return {
    ai_enabled: !!s.ai_enabled,
    ai_provider: s.ai_provider || 'anthropic',
    ai_model: s.ai_model || 'claude-sonnet-4-20250514',
    cursor_model: s.cursor_model || 'composer-2',
    cursor_repo_url: s.cursor_repo_url || '',
    ai_api_key_set: !!s.ai_api_key,
    cursor_api_key_set: !!s.cursor_api_key,
    claude_models: CLAUDE_MODELS,
    cursor_models: CURSOR_MODELS,
    templates: TEMPLATES,
  };
}

aiRouter.get('/ai/config', (_req, res) => {
  res.json(publicConfig());
});

aiRouter.put('/ai/config', (req, res) => {
  const b = req.body || {};
  const cur = getApp();
  const ai_enabled = 'ai_enabled' in b ? (b.ai_enabled ? 1 : 0) : (cur.ai_enabled ? 1 : 0);
  const ai_provider = b.ai_provider ?? cur.ai_provider ?? 'anthropic';
  const ai_model = b.ai_model ?? cur.ai_model ?? 'claude-sonnet-4-20250514';
  const cursor_model = b.cursor_model ?? cur.cursor_model ?? 'composer-2';
  const cursor_repo_url = b.cursor_repo_url ?? cur.cursor_repo_url ?? '';
  const ai_api_key =
    b.ai_api_key != null && b.ai_api_key !== '' ? b.ai_api_key : (cur.ai_api_key as string | null);
  const cursor_api_key =
    b.cursor_api_key != null && b.cursor_api_key !== ''
      ? b.cursor_api_key
      : (cur.cursor_api_key as string | null);

  db.prepare(
    `UPDATE app_settings SET ai_enabled=@ai_enabled, ai_provider=@ai_provider, ai_model=@ai_model,
       cursor_model=@cursor_model, cursor_repo_url=@cursor_repo_url,
       ai_api_key=@ai_api_key, cursor_api_key=@cursor_api_key WHERE id=1`
  ).run({ ai_enabled, ai_provider, ai_model, cursor_model, cursor_repo_url, ai_api_key, cursor_api_key });

  db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
    'info',
    'ai',
    `AI settings updated (provider: ${ai_provider})`
  );
  res.json(publicConfig());
});

async function testClaude(key: string) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
    }),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(err.slice(0, 200) || `HTTP ${r.status}`);
  }
  return { ok: true, message: 'Claude API key is valid.' };
}

async function testCursor(key: string) {
  const r = await fetch('https://api.cursor.com/v1/me', {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(err.slice(0, 200) || `HTTP ${r.status}`);
  }
  const data = (await r.json()) as { apiKeyName?: string; userEmail?: string };
  return {
    ok: true,
    message: `Cursor API connected${data.apiKeyName ? ` (${data.apiKeyName})` : ''}.`,
    detail: data,
  };
}

aiRouter.post('/ai/test', async (req, res) => {
  const provider = req.body?.provider || 'anthropic';
  const s = getApp();
  try {
    if (provider === 'cursor') {
      const key = req.body?.api_key || (s.cursor_api_key as string);
      if (!key) return res.status(400).json({ error: 'Cursor API key is required.' });
      const result = await testCursor(key);
      return res.json(result);
    }
    const key = req.body?.api_key || (s.ai_api_key as string);
    if (!key) return res.status(400).json({ error: 'Claude API key is required.' });
    const result = await testClaude(key);
    return res.json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Connection failed';
    res.status(400).json({ error: msg });
  }
});

async function generateWithClaude(prompt: string, model: string, key: string) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: ROUTEROS_SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(err.slice(0, 300) || `Claude API error ${r.status}`);
  }
  const data = (await r.json()) as { content?: { type: string; text?: string }[] };
  const text = data.content?.find((c) => c.type === 'text')?.text?.trim();
  if (!text) throw new Error('Empty response from Claude');
  return text;
}

async function generateWithCursor(prompt: string, model: string, key: string, repoUrl?: string) {
  if (!repoUrl?.trim()) {
    throw new Error('Cursor Cloud Agents require a Git repository URL. Set it in Setup → Cursor API.');
  }
  const r = await fetch('https://api.cursor.com/v0/agents', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt: { text: `${ROUTEROS_SYSTEM}\n\nUser request:\n${prompt}` },
      source: { repository: repoUrl.trim(), ref: 'main' },
      model: model || 'composer-2',
    }),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(err.slice(0, 300) || `Cursor API error ${r.status}`);
  }
  const data = (await r.json()) as { id?: string; status?: string; url?: string };
  return {
    script: `# Cursor Cloud Agent launched (id: ${data.id || 'unknown'})\n# Status: ${data.status || 'pending'}\n# Track progress: ${data.url || 'https://cursor.com/agents'}\n#\n# The agent is working on your repository. For instant RouterOS scripts,\n# switch provider to Claude (Anthropic) in Setup.`,
    agent: data,
  };
}

aiRouter.post('/ai/generate', async (req, res) => {
  const s = getApp();
  if (!s.ai_enabled) return res.status(400).json({ error: 'Enable AI Scripting in Setup first.' });

  const { prompt, provider, router_id } = req.body || {};
  if (!prompt?.trim()) return res.status(400).json({ error: 'Prompt is required.' });

  const useProvider = provider || s.ai_provider || 'anthropic';
  const router = router_id ? (db.prepare('SELECT name, host, board FROM routers WHERE id = ?').get(router_id) as { name: string; host: string; board: string } | undefined) : undefined;
  const context = router
    ? `\n\nTarget router: ${router.name} (${router.host}, ${router.board || 'MikroTik'})`
    : '';
  const fullPrompt = `${prompt.trim()}${context}`;

  try {
    let script: string;
    let meta: Record<string, unknown> = { provider: useProvider };

    if (useProvider === 'cursor') {
      const key = s.cursor_api_key as string;
      if (!key) return res.status(400).json({ error: 'Configure Cursor API key in Setup.' });
      const out = await generateWithCursor(fullPrompt, (s.cursor_model as string) || 'composer-2', key, s.cursor_repo_url as string);
      script = out.script;
      meta = { ...meta, agent: out.agent };
    } else {
      const key = s.ai_api_key as string;
      if (!key) return res.status(400).json({ error: 'Configure Claude API key in Setup.' });
      script = await generateWithClaude(fullPrompt, (s.ai_model as string) || 'claude-sonnet-4-20250514', key);
    }

    const info = db
      .prepare('INSERT INTO ai_scripts (provider, model, prompt, script, router_id) VALUES (?, ?, ?, ?, ?)')
      .run(useProvider, useProvider === 'cursor' ? s.cursor_model : s.ai_model, prompt, script, router_id || null);

    db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
      'info',
      'ai',
      `Generated script via ${useProvider} (#${info.lastInsertRowid})`
    );

    res.json({ id: info.lastInsertRowid, script, ...meta });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Generation failed';
    res.status(400).json({ error: msg });
  }
});

aiRouter.get('/ai/history', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT a.id, a.provider, a.model, a.prompt, a.script, a.router_id, a.created_at, r.name AS router_name
       FROM ai_scripts a LEFT JOIN routers r ON r.id = a.router_id
       ORDER BY a.id DESC LIMIT 30`
    )
    .all();
  res.json(rows);
});

aiRouter.delete('/ai/history/:id', (req, res) => {
  db.prepare('DELETE FROM ai_scripts WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});
