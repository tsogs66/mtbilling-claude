import express from 'express';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import QRCode from 'qrcode';
import { exec, spawn } from 'child_process';
import { db, backupsDir, dbPath, dataDir } from './db.js';
import { probeRouter, configureNonPaymentWebProxy, fetchSystemScripts, fetchSystemSchedulers, ensureBillingExpireSystemScript, ensureCaptiveWatchSystemScript, inspectNonPaymentCaptive, repairNonPaymentHttpRedirect, repairNonPaymentHttpRedirectViaScript } from './mikrotik.js';
import { panelHardwareId, verifyPasswordResetCode } from './panelId.js';
import { generateTotpSecret, totpUri, verifyTotpToken, generateBackupCodes } from './totp.js';
import { detectLanBaseUrl, detectLanIpv4, resolvePublicBaseUrl } from './billing.js';

export const settingsRouter = express.Router();

function writeCfTokenFile(token: string): string {
  const tokenPath = path.join(dataDir, 'cloudflare-tunnel.token');
  fs.writeFileSync(tokenPath, String(token || '').trim(), { mode: 0o600 });
  try {
    fs.chmodSync(tokenPath, 0o600);
  } catch {
    /* ignore */
  }
  return tokenPath;
}

/** Build apply/start args without --from-db (avoids sqlite3 CLI on RPi/PC flash). */
function cloudflareApplyArgs(s: any): string[] {
  const token = String(s.cf_tunnel_token || '');
  const host = String(s.cf_tunnel_hostname || '')
    .replace(/^https?:\/\//i, '')
    .replace(/\/$/, '');
  const port = String(s.cf_tunnel_port || 80);
  const tokenPath = writeCfTokenFile(token);
  return ['--token-file', tokenPath, '--hostname', host, '--port', port];
}

function hotSetPublicBaseUrl(url: string) {
  // Avoid restarting mt-billing-api after Cloudflare apply — a restart was a
  // common cause of "UI cannot login" while the unit was bouncing / crash-looping.
  try {
    process.env.PUBLIC_BASE_URL = url;
  } catch {
    /* ignore */
  }
}

function cloudflareLoginHints(url: string) {
  const lan = detectLanBaseUrl() || '';
  const lanIp = detectLanIpv4() || '';
  const tunnelLogin = url ? `${String(url).replace(/\/$/, '')}/login` : '';
  return {
    payPortalBase: url || '',
    /** Preferred staff URL when on-site; tunnel login also works if nginx is full-panel. */
    adminLoginUrl: lan ? `${lan.replace(/\/$/, '')}/login` : lanIp ? `http://${lanIp}/login` : tunnelLogin,
    tunnelLoginUrl: tunnelLogin,
    lanIp,
    loginWarning:
      'Staff can sign in on the Cloudflare hostname after nginx is healed for full panel. Disable Cloudflare Access (Zero Trust Application) and Bot Fight Mode on that hostname — they block POST /api/login at the edge. LAN IP login always works on-site.',
  };
}

// ---------- Panel / app settings ----------
const SECRET_FIELDS = ['ngrok_authtoken', 'ai_api_key', 'cursor_api_key', 'cf_tunnel_token'];
const BOOL_FIELDS = ['ngrok_enabled', 'ai_enabled', 'cf_tunnel_enabled'];
const EDITABLE = [
  'theme', 'currency', 'ngrok_enabled', 'ngrok_authtoken', 'ngrok_region',
  'ngrok_port', 'ai_provider', 'ai_api_key', 'ai_model', 'ai_enabled', 'cursor_api_key',
  'cursor_model', 'cursor_repo_url', 'tz', 'ntp_server', 'public_base_url',
  'cf_tunnel_token', 'cf_tunnel_hostname', 'cf_tunnel_port', 'cf_tunnel_enabled',
];

function getApp(): any {
  return db.prepare('SELECT * FROM app_settings WHERE id = 1').get();
}

function publicApp() {
  const s = getApp();
  const out: any = { ...s };
  for (const f of SECRET_FIELDS) {
    out[`${f}_set`] = !!s[f];
    delete out[f];
  }
  return out;
}

settingsRouter.get('/settings/app', (_req, res) => {
  res.json(publicApp());
});

settingsRouter.put('/settings/app', (req, res) => {
  const cur = getApp();
  const b = req.body || {};
  for (const f of EDITABLE) {
    if (!(f in b)) continue;
    if (SECRET_FIELDS.includes(f) && (b[f] == null || b[f] === '')) continue; // keep existing secret
    let v = b[f];
    if (BOOL_FIELDS.includes(f)) v = v ? 1 : 0;
    cur[f] = v;
  }
  // Normalize theme values
  const theme = ['light', 'dark', 'onepiece', 'steampunk', 'isptech', 'blueglass', 'matrix', 'orbital'].includes(cur.theme)
    ? cur.theme
    : 'matrix';
  db.prepare(
    `UPDATE app_settings SET theme=@theme, language=@language, currency=@currency,
       ngrok_enabled=@ngrok_enabled, ngrok_authtoken=@ngrok_authtoken, ngrok_region=@ngrok_region,
       ngrok_port=@ngrok_port, ai_provider=@ai_provider, ai_api_key=@ai_api_key, ai_model=@ai_model,
       ai_enabled=@ai_enabled, cursor_api_key=@cursor_api_key, cursor_model=@cursor_model,
       cursor_repo_url=@cursor_repo_url, tz=@tz, ntp_server=@ntp_server,
       public_base_url=@public_base_url,
       cf_tunnel_token=@cf_tunnel_token, cf_tunnel_hostname=@cf_tunnel_hostname,
       cf_tunnel_port=@cf_tunnel_port, cf_tunnel_enabled=@cf_tunnel_enabled
       WHERE id=1`
  ).run({
    theme,
    language: cur.language || 'en',
    currency: cur.currency || 'PHP',
    ngrok_enabled: cur.ngrok_enabled ? 1 : 0,
    ngrok_authtoken: cur.ngrok_authtoken || null,
    ngrok_region: cur.ngrok_region || 'ap',
    ngrok_port: Number(cur.ngrok_port) || 5173,
    ai_provider: cur.ai_provider || 'anthropic',
    ai_api_key: cur.ai_api_key || null,
    ai_model: cur.ai_model || 'claude-sonnet-4-20250514',
    ai_enabled: cur.ai_enabled ? 1 : 0,
    cursor_api_key: cur.cursor_api_key || null,
    cursor_model: cur.cursor_model || 'composer-2',
    cursor_repo_url: cur.cursor_repo_url || null,
    tz: cur.tz || 'Asia/Manila',
    ntp_server: cur.ntp_server || 'time.cloudflare.com',
    public_base_url: (() => {
      const host = (() => {
        const v = cur.cf_tunnel_hostname == null ? '' : String(cur.cf_tunnel_hostname).trim()
          .replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/\.$/, '').toLowerCase();
        return v || '';
      })();
      // Cloudflare Access / tunnel setup: keep website + pay links on the tunnel hostname.
      // Old saved bases (e.g. pay.example.com) otherwise stick and disagree with the tunnel UI.
      if (b.sync_public_from_tunnel && host) {
        return `https://${host}`;
      }
      if (host && !('public_base_url' in b)) {
        const existing = cur.public_base_url == null ? '' : String(cur.public_base_url).trim().replace(/\/$/, '');
        const existingHost = existing.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
        if (!existing || (existingHost && existingHost !== host)) {
          return `https://${host}`;
        }
      }
      const v = cur.public_base_url == null ? '' : String(cur.public_base_url).trim().replace(/\/$/, '');
      return v || null;
    })(),
    cf_tunnel_token: (() => {
      if (cur.cf_tunnel_token == null || cur.cf_tunnel_token === '') return null;
      return String(cur.cf_tunnel_token).replace(/[\r\n\t ]+/g, '').replace(/^['"]|['"]$/g, '') || null;
    })(),
    cf_tunnel_hostname: (() => {
      const v = cur.cf_tunnel_hostname == null ? '' : String(cur.cf_tunnel_hostname).trim()
        .replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/\.$/, '').toLowerCase();
      return v || null;
    })(),
    cf_tunnel_port: Number(cur.cf_tunnel_port) || 80,
    cf_tunnel_enabled: cur.cf_tunnel_enabled ? 1 : 0,
  });
  res.json(publicApp());
});

// ---------- Ngrok remote access (config + simulated tunnel status) ----------
// NOTE: This does NOT start a real ngrok process. Prefer Cloudflare Tunnel
// (System Settings → Cloudflare / /cloudflare) for production remote access.
settingsRouter.post('/ngrok/toggle', (_req, res) => {
  const s = getApp();
  const starting = s.ngrok_status !== 'running';
  if (starting && !s.ngrok_authtoken) {
    return res.status(400).json({ error: 'Set your ngrok auth token first.' });
  }
  const status = starting ? 'running' : 'stopped';
  const url = starting ? `https://${Math.random().toString(36).slice(2, 10)}.${s.ngrok_region || 'ap'}.ngrok.io` : null;
  db.prepare('UPDATE app_settings SET ngrok_status = ?, ngrok_url = ? WHERE id = 1').run(status, url);
  db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
    'warning',
    'ngrok',
    `SIMULATED tunnel ${status}${url ? ` at ${url}` : ''} — use Cloudflare Tunnel for real remote access`
  );
  res.json({
    status,
    url,
    simulated: true,
    message: 'Ngrok toggle is simulated. Use Cloudflare Tunnel for real public HTTPS access.',
  });
});

// ---------- Cloudflare Tunnel (real cloudflared via install script) ----------
const CF_TUNNEL_SCRIPT = path.join(
  process.env.INSTALL_DIR || process.env.var_install_dir || '/opt/mt-billing',
  'install/mt-billing-cloudflare-tunnel.sh'
);
function cloudflareTunnelScript(): string {
  const candidates = [
    CF_TUNNEL_SCRIPT,
    path.resolve(process.cwd(), '../install/mt-billing-cloudflare-tunnel.sh'),
    path.resolve(process.cwd(), 'install/mt-billing-cloudflare-tunnel.sh'),
    path.resolve(process.cwd(), '../../install/mt-billing-cloudflare-tunnel.sh'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return CF_TUNNEL_SCRIPT;
}

// install/*.sh log helpers (log_err etc.) colorize with ANSI SGR codes for a
// terminal; strip them here so script output shown in the panel UI doesn't
// render as raw "[1;31m[ERROR][0m ...".
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function runCloudflareTunnel(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const script = cloudflareTunnelScript();
    // sudoers allows /bin/bash + /usr/bin/bash only (not PATH `bash`).
    const tryCmds = [
      ['sudo', ['-n', '/bin/bash', script, ...args]],
      ['sudo', ['-n', '/usr/bin/bash', script, ...args]],
      ['bash', [script, ...args]],
    ] as [string, string[]][];

    const runNext = (i: number) => {
      if (i >= tryCmds.length) {
        resolve({
          code: 127,
          stdout: '',
          stderr:
            'Could not run Cloudflare Tunnel helper. One-time fix (SSH once): sudo bash /opt/mt-billing/install/mt-billing-grant-updater-root.sh — then retry Install & start tunnel from the panel (no SSH needed after that).',
        });
        return;
      }
      const [cmd, cmdArgs] = tryCmds[i];
      const child = spawn(cmd, cmdArgs, { env: process.env });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d) => { stdout += String(d); });
      child.stderr?.on('data', (d) => { stderr += String(d); });
      child.on('error', () => runNext(i + 1));
      child.on('close', (code) => {
        // sudo missing password / not allowed → try next
        if (i === 0 && code !== 0 && /password is required|a password is required|not allowed|No such file/i.test(stderr + stdout)) {
          runNext(i + 1);
          return;
        }
        resolve({ code: code ?? 1, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr) });
      });
    };
    runNext(0);
  });
}

// apply/start/stop can take anywhere from a few seconds to ~30-90s (apt-get
// installs, cloudflared install, token probe, cloudflared's own graceful
// shutdown grace period on stop) — far too long for a plain blocking
// request/response to be good UX. Run these as a background job instead,
// writing live output to a small log file, so the panel can show real
// progress via polling instead of just a frozen "Working…" button.
const CF_JOB_LOG = path.join(dataDir, 'cloudflare-tunnel-ui.log');
let cfJob: { running: boolean; action: string; code: number | null; startedAt: number } = {
  running: false,
  action: '',
  code: null,
  startedAt: 0,
};

function startCloudflareJob(
  args: string[],
  actionLabel: string,
  onDone: (code: number) => void
): { ok: boolean; error?: string } {
  if (cfJob.running) {
    return { ok: false, error: `A Cloudflare Tunnel operation (${cfJob.action}) is already running.` };
  }
  const script = cloudflareTunnelScript();
  cfJob = { running: true, action: actionLabel, code: null, startedAt: Date.now() };
  try {
    // Never log the raw token path contents; redact token-file path for privacy
    const safeArgs = args.map((a, i) => (args[i - 1] === '--token-file' ? '<token-file>' : a));
    fs.writeFileSync(CF_JOB_LOG, `$ sudo bash ${script} ${safeArgs.join(' ')}\n`);
  } catch {
    /* best-effort — job still runs without a visible log */
  }

  const tryCmds = [
    ['sudo', ['-n', '/bin/bash', script, ...args]],
    ['sudo', ['-n', '/usr/bin/bash', script, ...args]],
  ] as [string, string[]][];

  const appendLog = (s: string) => {
    try { fs.appendFileSync(CF_JOB_LOG, stripAnsi(s)); } catch { /* ignore */ }
  };

  const runNext = (i: number) => {
    if (i >= tryCmds.length) {
      appendLog(
        '\nCould not run Cloudflare Tunnel helper. One-time fix (SSH once): sudo bash /opt/mt-billing/install/mt-billing-grant-updater-root.sh — then retry from the panel (no SSH needed after that).\n'
      );
      cfJob = { ...cfJob, running: false, code: 127 };
      onDone(127);
      return;
    }
    const [cmd, cmdArgs] = tryCmds[i];
    const child = spawn(cmd, cmdArgs, { env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { const s = String(d); stdout += s; appendLog(s); });
    child.stderr?.on('data', (d) => { const s = String(d); stderr += s; appendLog(s); });
    child.on('error', () => runNext(i + 1));
    child.on('close', (code) => {
      if (i === 0 && code !== 0 && /password is required|a password is required|not allowed|No such file/i.test(stderr + stdout)) {
        runNext(i + 1);
        return;
      }
      const finalCode = code ?? 1;
      cfJob = { ...cfJob, running: false, code: finalCode };
      onDone(finalCode);
    });
  };
  runNext(0);
  return { ok: true };
}

settingsRouter.get('/cloudflare-tunnel/job', (_req, res) => {
  let log = '';
  try { log = fs.readFileSync(CF_JOB_LOG, 'utf8').slice(-8000); } catch { /* no job has run yet */ }
  res.json({ running: cfJob.running, action: cfJob.action, code: cfJob.code, startedAt: cfJob.startedAt, log });
});

function parseTunnelStatusOutput(stdout: string): { status: string; url: string } {
  const status = (stdout.match(/^status=(.+)$/m) || [])[1]?.trim() || 'stopped';
  const url = (stdout.match(/^url=(.*)$/m) || [])[1]?.trim() || '';
  return { status, url };
}

settingsRouter.get('/cloudflare-tunnel/status', async (_req, res) => {
  const result = await runCloudflareTunnel(['status']);
  if (result.code === 0) {
    const parsed = parseTunnelStatusOutput(result.stdout);
    const url = parsed.url || '';
    res.json({ ...parsed, ...publicApp(), ...cloudflareLoginHints(url), output: result.stdout.trim() });
    return;
  }
  // Fallback to DB values when systemd/script unavailable (dev)
  const s = getApp();
  const url = s.cf_tunnel_url || (s.cf_tunnel_hostname ? `https://${s.cf_tunnel_hostname}` : '');
  res.json({
    status: s.cf_tunnel_status || 'stopped',
    url,
    ...publicApp(),
    ...cloudflareLoginHints(url),
    warning: result.stderr || undefined,
  });
});

/** Heal nginx so the Cloudflare hostname serves full panel (/login + /api/), not pay-only 404s. */
settingsRouter.post('/cloudflare-tunnel/heal-nginx', async (_req, res) => {
  const s = getApp();
  const host = String(s.cf_tunnel_hostname || '')
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .trim();
  if (!host) return res.status(400).json({ error: 'Set the Cloudflare hostname first.' });
  const installDir = process.env.INSTALL_DIR || process.env.var_install_dir || '/opt/mt-billing';
  const script = path.join(installDir, 'install/mt-billing-nginx-staff-host.sh');
  const candidates = [
    script,
    path.resolve(process.cwd(), '../install/mt-billing-nginx-staff-host.sh'),
    path.resolve(process.cwd(), 'install/mt-billing-nginx-staff-host.sh'),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) return res.status(404).json({ error: 'nginx staff-host script not found on this appliance.' });
  try {
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const tryCmds: [string, string[]][] = [
        ['sudo', ['-n', '/bin/bash', found, host]],
        ['sudo', ['-n', '/usr/bin/bash', found, host]],
        ['/bin/bash', [found, host]],
      ];
      const run = (i: number) => {
        if (i >= tryCmds.length) {
          resolve({ code: 1, stdout: '', stderr: 'Could not run nginx heal script (need root/sudo).' });
          return;
        }
        const [cmd, args] = tryCmds[i];
        const child = spawn(cmd, args, { env: process.env });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (d) => {
          stdout += String(d);
        });
        child.stderr?.on('data', (d) => {
          stderr += String(d);
        });
        child.on('error', () => run(i + 1));
        child.on('close', (code) => {
          if (code === 0) resolve({ code: 0, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr) });
          else if (i + 1 < tryCmds.length) run(i + 1);
          else resolve({ code: code ?? 1, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr) });
        });
      };
      run(0);
    });
    if (result.code !== 0) {
      return res.status(500).json({
        error: result.stderr || result.stdout || 'nginx heal failed',
        hint: `Run on the appliance: sudo bash /opt/mt-billing/install/mt-billing-nginx-staff-host.sh ${host}`,
      });
    }
    const url = `https://${host}`;
    res.json({ ok: true, hostname: host, output: result.stdout, ...cloudflareLoginHints(url) });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'nginx heal failed' });
  }
});

settingsRouter.post('/cloudflare-tunnel/apply', async (_req, res) => {
  const s = getApp();
  if (!s.cf_tunnel_token) {
    return res.status(400).json({ error: 'Save your Cloudflare tunnel token first.' });
  }
  if (!s.cf_tunnel_hostname) {
    return res.status(400).json({ error: 'Set the public hostname (e.g. pay.yourisp.com) first.' });
  }
  const url = `https://${String(s.cf_tunnel_hostname).replace(/^https?:\/\//i, '').replace(/\/$/, '')}`;
  const started = startCloudflareJob([...cloudflareApplyArgs(s), 'apply'], 'apply', (code) => {
    if (code === 0) {
      db.prepare(
        `UPDATE app_settings SET cf_tunnel_status = 'running', cf_tunnel_url = ?, cf_tunnel_enabled = 1,
           public_base_url = ? WHERE id = 1`
      ).run(url, url);
      hotSetPublicBaseUrl(url);
      db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
        'info',
        'cloudflare',
        `Tunnel applied for ${s.cf_tunnel_hostname}`
      );
    } else {
      db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
        'error',
        'cloudflare',
        `Tunnel apply failed (exit ${code})`
      );
    }
  });
  if (!started.ok) return res.status(409).json({ error: started.error });
  res.json({ ok: true, started: true, ...cloudflareLoginHints(url) });
});

settingsRouter.post('/cloudflare-tunnel/toggle', async (_req, res) => {
  const s = getApp();
  const starting = s.cf_tunnel_status !== 'running';
  if (starting) {
    if (!s.cf_tunnel_token) {
      return res.status(400).json({ error: 'Save your Cloudflare tunnel token first.' });
    }
    if (!s.cf_tunnel_hostname) {
      return res.status(400).json({ error: 'Set the public hostname first.' });
    }
    const url = `https://${String(s.cf_tunnel_hostname).replace(/^https?:\/\//i, '').replace(/\/$/, '')}`;
    const onStarted = (code: number) => {
      if (code === 0) {
        db.prepare(
          `UPDATE app_settings SET cf_tunnel_status = 'running', cf_tunnel_url = ?, cf_tunnel_enabled = 1,
             public_base_url = ? WHERE id = 1`
        ).run(url, url);
        hotSetPublicBaseUrl(url);
        db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run('info', 'cloudflare', `Tunnel started at ${url}`);
      } else {
        db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run('error', 'cloudflare', `Tunnel start failed (exit ${code})`);
      }
    };
    // Prefer full apply (installs the unit if missing); fall back to a plain
    // start if apply itself fails (e.g. unit already configured correctly).
    const started = startCloudflareJob([...cloudflareApplyArgs(s), 'apply'], 'start', (code) => {
      if (code === 0) { onStarted(0); return; }
      const retried = startCloudflareJob([...cloudflareApplyArgs(s), 'start'], 'start', onStarted);
      if (!retried.ok) onStarted(code);
    });
    if (!started.ok) return res.status(409).json({ error: started.error });
    return res.json({ ok: true, started: true, ...cloudflareLoginHints(url) });
  }

  const started = startCloudflareJob(['stop'], 'stop', (code) => {
    db.prepare(`UPDATE app_settings SET cf_tunnel_status = 'stopped', cf_tunnel_enabled = 0 WHERE id = 1`).run();
    db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
      'info',
      'cloudflare',
      code === 0 ? 'Tunnel stopped' : `Tunnel stop finished with exit ${code}`
    );
  });
  if (!started.ok) return res.status(409).json({ error: started.error });
  res.json({ ok: true, started: true });
});

// ---------- Database management ----------
/** Selective backup categories → tables (missing tables are skipped). */
export const BACKUP_CATEGORIES: Record<string, string[]> = {
  settings: ['app_settings', 'company', 'users', 'notify_settings', 'fair_use_settings'],
  clients: ['pppoe_users', 'profiles', 'ipoe_profiles', 'ipoe_plans', 'ipoe_lease_meta'],
  network: ['routers', 'naps', 'splitters', 'splitter_loss_reference', 'noc_devices', 'queues'],
  reports: ['transactions', 'payment_links', 'invoices', 'invoice_payments', 'expenses'],
  operations: [
    'notifications',
    'job_orders',
    'ai_scripts',
    'inventory',
    'usage_alerts',
    'cashier_collectibles',
    'cashier_deposits',
  ],
};

function listExistingTables(): Set<string> {
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

settingsRouter.get('/db/backup-categories', (_req, res) => {
  const existing = listExistingTables();
  const categories = Object.entries(BACKUP_CATEGORIES).map(([id, tables]) => ({
    id,
    tables: tables.filter((t) => existing.has(t)),
    label:
      id === 'settings'
        ? 'Settings'
        : id === 'clients'
          ? 'Clients / subscribers'
          : id === 'network'
            ? 'Network'
            : id === 'reports'
              ? 'Reports / billing'
              : 'Operations',
  }));
  res.json({ categories });
});

settingsRouter.post('/db/backup', async (_req, res) => {
  try {
    const name = `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
    await db.backup(path.join(backupsDir, name));
    res.json({ ok: true, name });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'backup failed' });
  }
});

/** Selective JSON backup by category (downloadable without full DB replace). */
settingsRouter.post('/db/backup/selective', (req, res) => {
  try {
    const cats = (Array.isArray(req.body?.categories) ? req.body.categories : [])
      .map((c: unknown) => String(c))
      .filter((c: string) => BACKUP_CATEGORIES[c]);
    if (!cats.length) return res.status(400).json({ error: 'Select at least one category.' });
    const existing = listExistingTables();
    const payload: Record<string, unknown[]> = {};
    const included: string[] = [];
    for (const cat of cats) {
      for (const table of BACKUP_CATEGORIES[cat]) {
        if (!existing.has(table)) continue;
        payload[table] = db.prepare(`SELECT * FROM ${table}`).all() as unknown[];
        included.push(table);
      }
    }
    const name = `selective-${cats.join('-')}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const full = path.join(backupsDir, name);
    fs.writeFileSync(full, JSON.stringify({ version: 1, categories: cats, tables: included, data: payload }, null, 2));
    res.json({ ok: true, name, tables: included, categories: cats });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Selective backup failed' });
  }
});

/** Restore selective JSON (merges/replaces rows per table; does not wipe unrelated data). */
settingsRouter.post('/db/restore/selective', express.json({ limit: '80mb' }), (req, res) => {
  try {
    const body = req.body || {};
    const data = body.data && typeof body.data === 'object' ? body.data : body;
    const cats = Array.isArray(body.categories) ? body.categories.map(String) : Object.keys(BACKUP_CATEGORIES);
    const allowed = new Set<string>();
    for (const c of cats) {
      for (const t of BACKUP_CATEGORIES[c] || []) allowed.add(t);
    }
    const existing = listExistingTables();
    let tablesRestored = 0;
    let rows = 0;
    const tx = db.transaction(() => {
      for (const [table, list] of Object.entries(data)) {
        if (!allowed.has(table) || !existing.has(table) || !Array.isArray(list)) continue;
        const colsInfo = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
        const colNames = colsInfo.map((c) => c.name);
        if (!colNames.length) continue;
        // Replace table contents for selected category tables
        db.prepare(`DELETE FROM ${table}`).run();
        const placeholders = colNames.map(() => '?').join(',');
        const insert = db.prepare(
          `INSERT INTO ${table} (${colNames.join(',')}) VALUES (${placeholders})`
        );
        for (const row of list as Record<string, unknown>[]) {
          insert.run(...colNames.map((c) => (row[c] !== undefined ? row[c] : null)));
          rows += 1;
        }
        tablesRestored += 1;
      }
    });
    tx();
    db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
      'warning',
      'database',
      `Selective restore applied (${tablesRestored} tables, ${rows} rows)`
    );
    res.json({ ok: true, tablesRestored, rows });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Selective restore failed' });
  }
});

settingsRouter.get('/db/backups', (_req, res) => {
  const files = fs
    .readdirSync(backupsDir)
    .filter((f) => f.endsWith('.db') || f.endsWith('.json'))
    .map((f) => {
      const st = fs.statSync(path.join(backupsDir, f));
      return { name: f, size: st.size, created: st.mtime.toISOString(), kind: f.endsWith('.json') ? 'selective' : 'full' };
    })
    .sort((a, b) => (a.created < b.created ? 1 : -1));
  res.json(files);
});

function safeBackupPath(name: string): string | null {
  const base = path.basename(name); // prevent path traversal
  if (!base.endsWith('.db') && !base.endsWith('.json')) return null;
  const full = path.join(backupsDir, base);
  return fs.existsSync(full) ? full : null;
}

settingsRouter.get('/db/backups/:name/download', (req, res) => {
  const full = safeBackupPath(req.params.name);
  if (!full) return res.status(404).json({ error: 'not found' });
  res.download(full);
});

settingsRouter.delete('/db/backups/:name', (req, res) => {
  const full = safeBackupPath(req.params.name);
  if (!full) return res.status(404).json({ error: 'not found' });
  fs.rmSync(full);
  res.json({ ok: true });
});

// Restore from an uploaded raw SQLite file (application/octet-stream — see
// the express.raw() middleware below, kept separate from the app-wide
// express.json() limit since backups are much larger than typical JSON
// bodies and a base64/JSON wrapper would inflate the upload by ~33%).
// The client gzips the file before sending (?gzip=1) when the browser
// supports it — this both speeds up the upload and, more importantly,
// gives large backups a real chance of staying under a reverse tunnel's
// (e.g. Cloudflare Tunnel's ~100MB) hard request-size cap, which no
// server-side limit can raise. Staged then applied on API restart.
settingsRouter.post('/db/restore', express.raw({ type: '*/*', limit: '300mb' }), (req, res) => {
  let buf = Buffer.isBuffer(req.body) ? req.body : null;
  req.body = null; // drop the only other reference so the compressed copy is collectible once decompressed
  if (!buf || !buf.length) {
    return res.status(400).json({ error: 'No file uploaded. Choose a .db or .sqlite backup first.' });
  }
  try {
    if (req.query.gzip === '1') {
      try {
        buf = zlib.gunzipSync(buf);
      } catch {
        return res.status(400).json({ error: 'Uploaded backup could not be decompressed — the transfer may have been corrupted. Try again.' });
      }
    }
    if (buf.length < 1024) {
      return res.status(400).json({ error: 'Backup file is too small to be a panel database.' });
    }
    const magic = buf.subarray(0, 16).toString('utf8');
    if (!magic.startsWith('SQLite format 3')) {
      return res.status(400).json({
        error: 'Not a valid SQLite database (.db). Export a panel backup or use a file that starts with “SQLite format 3”.',
      });
    }
    const pending = `${dbPath}.pending`;
    fs.writeFileSync(pending, buf);
    db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
      'warning',
      'database',
      `Restore staged (${buf.length} bytes); applying on API restart`
    );
    const restart = req.query.restart !== '0';
    res.json({
      ok: true,
      restartRequired: true,
      bytes: buf.length,
      message: restart
        ? 'Backup staged. Restarting API to apply…'
        : 'Backup staged. Restart the API to apply it.',
    });
    if (restart) scheduleApiRestart();
  } catch (e: any) {
    const msg = String(e?.message || 'restore failed');
    if (/entity too large|request entity too large|413/i.test(msg)) {
      return res.status(413).json({
        error:
          'Backup rejected as too large by a reverse proxy or tunnel in front of the panel. If nginx is directly in front of the panel: sudo sed -i "s/client_max_body_size[[:space:]]*[0-9]*m;/client_max_body_size 300m;/g" /etc/nginx/sites-available/mt-billing && sudo nginx -t && sudo systemctl reload nginx — but if you are accessing the panel through a Cloudflare Tunnel, its ~100MB request cap cannot be raised from this side; restore from the panel\'s local network address instead.',
      });
    }
    res.status(500).json({ error: msg });
  }
});

// ---------- Time synchronization ----------
settingsRouter.get('/time', (_req, res) => {
  const s = getApp();
  res.json({ serverTime: new Date().toISOString(), tz: s.tz, ntp_server: s.ntp_server });
});

settingsRouter.post('/time/sync', (_req, res) => {
  const s = getApp();
  db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run('info', 'time', `NTP sync with ${s.ntp_server}`);
  res.json({ ok: true, serverTime: new Date().toISOString(), ntp_server: s.ntp_server });
});

// ---------- Account reset (require current password OR vendor recovery key) ----------
settingsRouter.post('/account/reset-password', (req: any, res) => {
  const { newPassword, currentPassword, recoveryKey } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  const username = req.user?.username;
  if (!username) return res.status(401).json({ error: 'Not authenticated.' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
    | { id: number; username: string; password_hash: string }
    | undefined;
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const hasCurrent = currentPassword != null && String(currentPassword).length > 0;
  const hasRecovery = recoveryKey != null && String(recoveryKey).trim().length > 0;
  if (!hasCurrent && !hasRecovery) {
    return res.status(400).json({
      error: 'Provide your current password or a password recovery key from the vendor activator.',
    });
  }

  let authorized = false;
  if (hasCurrent) {
    authorized = bcrypt.compareSync(String(currentPassword), user.password_hash);
    if (!authorized && !hasRecovery) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }
  }
  if (!authorized && hasRecovery) {
    const hwid = panelHardwareId();
    authorized = verifyPasswordResetCode(hwid, String(recoveryKey));
    if (!authorized) {
      db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
        'warning',
        'account',
        `Invalid recovery key during password change for ${username}`
      );
      return res.status(401).json({ error: 'Invalid recovery key for this panel.' });
    }
  }

  const hash = bcrypt.hashSync(String(newPassword), 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
  db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
    'warning',
    'account',
    `Password changed for ${username}${hasRecovery && !hasCurrent ? ' via recovery key' : ''}`
  );
  res.json({ ok: true });
});

// ---------- Two-factor authentication (TOTP) ----------
// Self-service, per-account. A secret is only committed to totp_secret (and the
// account only gated on login) after /2fa/confirm proves the user actually
// scanned it — otherwise a typo'd setup could permanently lock the account out.
const pendingTotpSecrets = new Map<number, string>();

settingsRouter.get('/account/2fa/status', (req: any, res) => {
  const row = db.prepare('SELECT totp_enabled FROM users WHERE id = ?').get(req.user.id) as
    | { totp_enabled: number }
    | undefined;
  res.json({ enabled: !!row?.totp_enabled });
});

settingsRouter.post('/account/2fa/setup', async (req: any, res) => {
  const user = db.prepare('SELECT id, username, totp_enabled FROM users WHERE id = ?').get(req.user.id) as
    | { id: number; username: string; totp_enabled: number }
    | undefined;
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (user.totp_enabled) return res.status(400).json({ error: 'Two-factor is already enabled. Disable it first to re-enroll.' });

  const secret = generateTotpSecret();
  pendingTotpSecrets.set(user.id, secret);
  const uri = totpUri(secret, user.username);
  const qrDataUrl = await QRCode.toDataURL(uri, { margin: 1, width: 240 });
  res.json({ secret, uri, qrDataUrl });
});

settingsRouter.post('/account/2fa/confirm', (req: any, res) => {
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.user.id) as
    | { id: number; username: string }
    | undefined;
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const secret = pendingTotpSecrets.get(user.id);
  if (!secret) return res.status(400).json({ error: 'No pending setup — start again from Enable 2FA.' });

  const code = String(req.body?.code || '').trim();
  if (!verifyTotpToken(secret, code)) {
    return res.status(400).json({ error: 'Incorrect code. Check the time on your device and try again.' });
  }

  const backupCodes = generateBackupCodes();
  const hashedCodes = backupCodes.map((c) => bcrypt.hashSync(c, 10));
  db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 1, totp_backup_codes = ? WHERE id = ?').run(
    secret,
    JSON.stringify(hashedCodes),
    user.id
  );
  pendingTotpSecrets.delete(user.id);
  db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
    'warning',
    'account',
    `Two-factor authentication enabled for ${user.username}`
  );
  // Shown once — the panel never stores these in plaintext, only bcrypt hashes.
  res.json({ ok: true, backupCodes });
});

settingsRouter.post('/account/2fa/disable', (req: any, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id) as
    | { id: number; username: string; password_hash: string; totp_enabled: number }
    | undefined;
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (!user.totp_enabled) return res.json({ ok: true });

  const password = String(req.body?.password || '');
  if (!password || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Current password is required to disable two-factor.' });
  }
  db.prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_backup_codes = NULL WHERE id = ?').run(user.id);
  pendingTotpSecrets.delete(user.id);
  db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
    'warning',
    'account',
    `Two-factor authentication disabled for ${user.username}`
  );
  res.json({ ok: true });
});

// ---------- Server restart ----------
function scheduleApiRestart() {
  setTimeout(() => {
    // The service runs as an unprivileged user — restarting the systemd unit
    // needs the passwordless sudo grant set up for exactly this command (see
    // install/mt-billing-sudoers). Without `sudo` this always fails silently
    // (stderr is discarded) and falls through to the much slower/fragile
    // self-respawn path below on every single restart.
    exec('sudo -n systemctl restart mt-billing-api 2>/dev/null', (sysErr) => {
      if (!sysErr) return; // systemd will stop this process

      exec('pm2 restart mt-billing 2>/dev/null || pm2 restart mt-billing-api 2>/dev/null', (pmErr) => {
        if (!pmErr) return;

        // Dev / manual: ask the HTTP server to close, then exit so `tsx watch` respawns us.
        // Emitting lets index.ts close sockets cleanly before exit.
        try {
          process.emit('mt-billing-restart' as any);
        } catch {
          /* ignore */
        }
        setTimeout(() => {
          // Re-spawn ourselves if nothing is watching (plain `node dist/index.js`).
          const isTsx = process.argv.some((a) => a.includes('tsx'));
          if (!isTsx) {
            try {
              const child = spawn(process.execPath, process.argv.slice(1), {
                detached: true,
                stdio: 'ignore',
                cwd: process.cwd(),
                env: process.env,
              });
              child.unref();
            } catch {
              /* ignore */
            }
          }
          process.exit(1);
        }, 600);
      });
    });
  }, 500);
}

settingsRouter.post('/settings/restart-server', (_req, res) => {
  db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
    'warning',
    'server',
    'API server restart requested from System Settings'
  );
  res.json({ ok: true, message: 'Server is restarting. The panel may be unavailable for a few seconds.' });
  scheduleApiRestart();
});

// ---------- Router management (CRUD) ----------
settingsRouter.post('/routers/test', async (req, res) => {
  const b = req.body || {};
  const id = Number(b.id) || 0;
  const ex = id ? (db.prepare('SELECT * FROM routers WHERE id = ?').get(id) as any) : null;
  const conn = {
    host: b.host || ex?.host,
    port: Number(b.port) || ex?.port || 8728,
    api_user: b.api_user || ex?.api_user,
    api_pass: b.api_pass != null && b.api_pass !== '' ? b.api_pass : ex?.api_pass || '',
  };
  const result = await probeRouter(conn);
  res.json({
    online: result.online,
    status: result.online ? 'online' : 'offline',
    board: result.board,
    identity: result.identity,
    version: result.version,
    error: result.error,
  });
});

/**
 * Non-payment captive helper (portal-pay flow):
 * ensure HTTP + HTTPS redirect to webproxy (error.html → /portal),
 * allow HTTPS only to billing + PayMongo, fetch error.html, lockdown bypass,
 * install System → Scripts mtb-billing-expire scanner.
 */
settingsRouter.post('/routers/:id/nonpayment-webproxy', async (req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare('SELECT * FROM routers WHERE id = ?').get(id) as any;
  if (!r) return res.status(404).json({ error: 'Router not found' });
  const b = req.body || {};
  const app = getApp();
  const publicBase =
    String(b.billingBaseUrl || b.publicBaseUrl || app?.public_base_url || process.env.PUBLIC_BASE_URL || '')
      .trim()
      .replace(/\/$/, '') || 'https://panorth.tsogs.cloud';
  let billingHost = String(b.billingHost || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '');
  if (!billingHost) {
    try {
      billingHost = new URL(publicBase).hostname;
    } catch {
      billingHost = 'panorth.tsogs.cloud';
    }
  }
  const errorPageUrl =
    String(b.errorPageUrl || '').trim() || `${publicBase}/error.html`;
  const lanIp = detectLanIpv4();
  // Detected or caller-supplied only. This list is a firewall allowlist punched
  // through the non-payment lockdown, and it used to carry one deployment's
  // 192.168.0.120 unconditionally — granting whatever sat at that address on
  // every other install. Pass billingLanIps explicitly if detection picks the
  // wrong interface (a Docker bridge, say) on a multi-homed host.
  const billingLanIps = [
    ...(Array.isArray(b.billingLanIps) ? b.billingLanIps : []),
    lanIp,
  ]
    .map((x) => String(x || '').trim())
    .filter(Boolean);
  if (!billingLanIps.length) {
    console.warn(
      '[captive] no billing LAN IP detected or supplied — landing:captiveApiPort dst-nat will be skipped'
    );
  }
  const conn = {
    host: r.host,
    port: Number(r.port) || 8728,
    api_user: r.api_user,
    api_pass: r.api_pass || '',
  };
  try {
    const kickUser = String(b.kickUsername || b.username || '').trim();
    // Prefer script-based repair — direct /ip/proxy API can hang on this board.
    let repair: Awaited<ReturnType<typeof repairNonPaymentHttpRedirect>> | Awaited<
      ReturnType<typeof repairNonPaymentHttpRedirectViaScript>
    >;
    try {
      const viaScript = await repairNonPaymentHttpRedirectViaScript(conn, {
        nonPayCidr: b.nonPayCidr,
        proxyPort: b.proxyPort,
        portalRedirectUrl: `${publicBase}/portal`,
        // Local MikroTik Files/webproxy/error.html via action=deny (not external URL).
        username: kickUser || undefined,
        billingLanIp: lanIp || undefined,
        landingAddress: b.landingAddress,
        captiveApiPort: b.captiveApiPort,
      });
      repair = {
        ok: true as const,
        proxyEnabled: true,
        natHttpRedirect: true,
        proxyRedirect: true,
        portalRedirectTo: 'webproxy/error.html',
        kicked: viaScript.kicked ?? null,
        viaScript: viaScript.ran,
        scheduledAt: viaScript.scheduledAt || null,
        watch: viaScript.watch || null,
        nat: viaScript.nat || null,
      } as any;
    } catch (scriptErr: any) {
      // Last resort: direct API (may hang on /ip/proxy) + still install watch.
      try {
        await ensureCaptiveWatchSystemScript(conn, {
          nonPayCidr: b.nonPayCidr,
          proxyPort: b.proxyPort,
          portalRedirectUrl: `${publicBase}/portal`,
          // Detected, not assumed — the watch script used to bake in one
          // deployment's LAN address.
          billingLanIp: lanIp || undefined,
          landingAddress: b.landingAddress,
        });
      } catch {
        /* ignore */
      }
      repair = await repairNonPaymentHttpRedirect(conn, {
        nonPayCidr: b.nonPayCidr,
        proxyPort: b.proxyPort,
        nonPayAddressList: b.nonPayAddressList,
        portalRedirectUrl: `${publicBase}/portal`,
        username: kickUser || undefined,
      });
      (repair as any).scriptError = scriptErr?.message || String(scriptErr);
    }

    if (kickUser) {
      try {
        db.prepare(
          `UPDATE pppoe_users
           SET status = 'non-payment',
               nonpayment_since = COALESCE(nonpayment_since, ?)
           WHERE router_id = ? AND lower(username) = lower(?)`
        ).run(new Date().toISOString(), id, kickUser);
      } catch {
        /* ignore */
      }
    }

    let full: Awaited<ReturnType<typeof configureNonPaymentWebProxy>> | null = null;
    let fullError: string | null = null;
    if (b.full !== false && b.quick !== true) {
      try {
        full = await configureNonPaymentWebProxy(conn, {
          nonPayCidr: b.nonPayCidr,
          landingAddress: b.landingAddress,
          billingHost,
          allowHosts: Array.isArray(b.allowHosts) ? b.allowHosts : undefined,
          errorPageUrl: b.fetchErrorHtml === false ? undefined : errorPageUrl,
          portalRedirectUrl: `${publicBase}/portal`,
          proxyPort: b.proxyPort,
          lockdownFirewall: b.lockdownFirewall !== false,
          nonPayAddressList: b.nonPayAddressList,
          billingLanIps,
          lockRouterUi: b.lockRouterUi !== false,
          routerMgmtCidrs: Array.isArray(b.routerMgmtCidrs) ? b.routerMgmtCidrs : undefined,
        });
      } catch (e: any) {
        fullError = e?.message || String(e);
      }
    }

    const inspect =
      b.skipInspect === true || b.quick === true
        ? undefined
        : await inspectNonPaymentCaptive(conn, {
            nonPayCidr: b.nonPayCidr,
            landingAddress: b.landingAddress,
            proxyPort: b.proxyPort,
            username: kickUser || 'Admin',
          }).catch((e: any) => ({ error: e?.message || String(e) }));

    res.json({
      ok: true,
      repair,
      full,
      fullError,
      kick: kickUser
        ? { username: kickUser, ok: !!repair.kicked, kicked: repair.kicked }
        : null,
      inspect,
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/** Diagnose why non-payment webproxy redirect may not fire for a secret. */
settingsRouter.get('/routers/:id/nonpayment-captive', async (req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare('SELECT * FROM routers WHERE id = ?').get(id) as any;
  if (!r) return res.status(404).json({ error: 'Router not found' });
  try {
    const inspect = await inspectNonPaymentCaptive(
      {
        host: r.host,
        port: Number(r.port) || 8728,
        api_user: r.api_user,
        api_pass: r.api_pass || '',
      },
      {
        nonPayCidr: req.query.nonPayCidr ? String(req.query.nonPayCidr) : undefined,
        landingAddress: req.query.landingAddress ? String(req.query.landingAddress) : undefined,
        proxyPort: req.query.proxyPort ? Number(req.query.proxyPort) : undefined,
        username: String(req.query.username || 'Admin'),
      }
    );
    res.json(inspect);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/** Inspect /system/script + /system/scheduler (Winbox System → Scripts). */
settingsRouter.get('/routers/:id/system-scripts', async (req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare('SELECT * FROM routers WHERE id = ?').get(id) as any;
  if (!r) return res.status(404).json({ error: 'Router not found' });
  const conn = {
    host: r.host,
    port: Number(r.port) || 8728,
    api_user: r.api_user,
    api_pass: r.api_pass || '',
  };
  const mtbOnly = String(req.query.mtb || '') === '1' || String(req.query.mtb || '') === 'true';
  const includeSource =
    String(req.query.source || '') === '1' || String(req.query.source || '') === 'true';
  try {
    const scripts = await fetchSystemScripts(conn, { includeSource });
    let schedulers: Awaited<ReturnType<typeof fetchSystemSchedulers>> = [];
    try {
      schedulers = await fetchSystemSchedulers(conn);
    } catch {
      schedulers = [];
    }
    const filterMtb = <T extends { name: string }>(rows: T[]) =>
      mtbOnly ? rows.filter((x) => String(x.name || '').startsWith('mtb-')) : rows;
    res.json({
      routerId: id,
      router: r.name,
      scripts: filterMtb(scripts),
      schedulers: filterMtb(schedulers),
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/** Install/replace the global mtb-billing-expire System script + 5-min scheduler. */
settingsRouter.post('/routers/:id/billing-expire-script', async (req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare('SELECT * FROM routers WHERE id = ?').get(id) as any;
  if (!r) return res.status(404).json({ error: 'Router not found' });
  const b = req.body || {};
  try {
    const result = await ensureBillingExpireSystemScript(
      {
        host: r.host,
        port: Number(r.port) || 8728,
        api_user: r.api_user,
        api_pass: r.api_pass || '',
      },
      {
        nonPaymentProfile: b.nonPaymentProfile || 'non-payments',
        interval: b.interval || '00:05:00',
      }
    );
    res.json({ ok: true, ...result });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

settingsRouter.post('/routers', async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name is required' });
  const conn = {
    host: b.host,
    port: Number(b.port) || 8728,
    api_user: b.api_user,
    api_pass: b.api_pass || '',
  };
  const probe = await probeRouter(conn);
  const status = probe.online ? 'online' : 'offline';
  const board = probe.board || b.board || null;
  const info = db
    .prepare('INSERT INTO routers (name, host, port, ssh_port, api_user, api_pass, board, type, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(b.name, b.host || null, Number(b.port) || 8728, Number(b.ssh_port) || 22, b.api_user || null, b.api_pass || null, board, b.type || 'pppoe', status);
  res.status(201).json(db.prepare('SELECT id, name, host, port, ssh_port, board, type, status FROM routers WHERE id = ?').get(info.lastInsertRowid));
});

settingsRouter.put('/routers/:id', async (req, res) => {
  const id = Number(req.params.id);
  const ex = db.prepare('SELECT * FROM routers WHERE id = ?').get(id) as any;
  if (!ex) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const host = b.host ?? ex.host;
  const port = Number(b.port) || ex.port;
  const api_user = b.api_user ?? ex.api_user;
  const api_pass = b.api_pass != null && b.api_pass !== '' ? b.api_pass : ex.api_pass;
  const probe = await probeRouter({ host, port, api_user, api_pass });
  const status = probe.online ? 'online' : 'offline';
  const board = probe.board || b.board || ex.board;
  db.prepare('UPDATE routers SET name=?, host=?, port=?, ssh_port=?, api_user=?, api_pass=?, board=?, type=?, status=? WHERE id=?').run(
    b.name ?? ex.name,
    host,
    port,
    Number(b.ssh_port) || ex.ssh_port || 22,
    api_user,
    api_pass,
    board,
    b.type ?? ex.type,
    status,
    id
  );
  res.json(db.prepare('SELECT id, name, host, port, ssh_port, board, type, status FROM routers WHERE id = ?').get(id));
});

settingsRouter.delete('/routers/:id', (req, res) => {
  db.prepare('DELETE FROM routers WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});
