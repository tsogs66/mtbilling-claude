import express from 'express';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { db } from './db.js';

export const twingateRouter = express.Router();

const dataDir = path.join(process.cwd(), 'data');
try {
  fs.mkdirSync(dataDir, { recursive: true });
} catch {
  /* ignore */
}

function columnExists(table: string, col: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === col);
}

export function initTwingate() {
  for (const [col, type] of [
    ['twingate_service_key', 'TEXT'],
    ['twingate_network', 'TEXT'],
    ['twingate_status', "TEXT DEFAULT 'stopped'"],
    ['twingate_enabled', 'INTEGER DEFAULT 0'],
    ['twingate_node_name', 'TEXT'],
  ] as [string, string][]) {
    if (!columnExists('app_settings', col)) db.exec(`ALTER TABLE app_settings ADD COLUMN ${col} ${type}`);
  }
}

function getTg() {
  return db
    .prepare(
      `SELECT twingate_service_key, twingate_network, twingate_status, twingate_enabled, twingate_node_name
       FROM app_settings WHERE id = 1`
    )
    .get() as {
    twingate_service_key: string | null;
    twingate_network: string | null;
    twingate_status: string | null;
    twingate_enabled: number | null;
    twingate_node_name: string | null;
  };
}

function networkFromKey(raw: string | null | undefined): string {
  if (!raw) return '';
  try {
    const j = JSON.parse(raw);
    return String(j.network || '').replace(/\.twingate\.com$/i, '') || String(j.network || '');
  } catch {
    return '';
  }
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

const TG_SCRIPT = path.join(
  process.env.INSTALL_DIR || process.env.var_install_dir || '/opt/mt-billing',
  'install/mt-billing-twingate.sh'
);

function twingateScript(): string {
  const candidates = [
    TG_SCRIPT,
    path.resolve(process.cwd(), '../install/mt-billing-twingate.sh'),
    path.resolve(process.cwd(), 'install/mt-billing-twingate.sh'),
    path.resolve(process.cwd(), '../../install/mt-billing-twingate.sh'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return TG_SCRIPT;
}

function runTwingateScript(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const script = twingateScript();
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
            'Could not run Twingate helper. One-time fix (SSH once): sudo bash /opt/mt-billing/install/mt-billing-grant-updater-root.sh — then retry Install & connect from the panel.',
        });
        return;
      }
      const [cmd, cmdArgs] = tryCmds[i];
      const child = spawn(cmd, cmdArgs, { env: process.env });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d) => {
        stdout += String(d);
      });
      child.stderr?.on('data', (d) => {
        stderr += String(d);
      });
      child.on('error', () => runNext(i + 1));
      child.on('close', (code) => {
        if (
          i === 0 &&
          code !== 0 &&
          /password is required|a password is required|not allowed|No such file/i.test(stderr + stdout)
        ) {
          runNext(i + 1);
          return;
        }
        resolve({ code: code ?? 1, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr) });
      });
    };
    runNext(0);
  });
}

const TG_JOB_LOG = path.join(dataDir, 'twingate-ui.log');
let tgJob: { running: boolean; action: string; code: number | null; startedAt: number } = {
  running: false,
  action: '',
  code: null,
  startedAt: 0,
};

/** Write Service Key for the install script — avoids --from-db / sqlite3 CLI (apt 404s, flash images). */
function writeTwingateKeyFile(key: string): string {
  const keyPath = path.join(dataDir, 'twingate-service-key.json');
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  try {
    fs.chmodSync(keyPath, 0o600);
  } catch {
    /* ignore */
  }
  return keyPath;
}

function startTwingateJob(
  args: string[],
  actionLabel: string,
  onDone: (code: number) => void
): { ok: boolean; error?: string } {
  if (tgJob.running) {
    return { ok: false, error: `A Twingate operation (${tgJob.action}) is already running.` };
  }
  const script = twingateScript();
  tgJob = { running: true, action: actionLabel, code: null, startedAt: Date.now() };
  try {
    fs.writeFileSync(TG_JOB_LOG, `$ sudo bash ${script} ${args.join(' ')}\n`);
  } catch {
    /* ignore */
  }

  const tryCmds = [
    ['sudo', ['-n', '/bin/bash', script, ...args]],
    ['sudo', ['-n', '/usr/bin/bash', script, ...args]],
  ] as [string, string[]][];

  const appendLog = (s: string) => {
    try {
      fs.appendFileSync(TG_JOB_LOG, stripAnsi(s));
    } catch {
      /* ignore */
    }
  };

  const runNext = (i: number) => {
    if (i >= tryCmds.length) {
      appendLog(
        '\nCould not run Twingate helper. One-time fix (SSH once): sudo bash /opt/mt-billing/install/mt-billing-grant-updater-root.sh — then retry from the panel.\n'
      );
      tgJob = { ...tgJob, running: false, code: 127 };
      onDone(127);
      return;
    }
    const [cmd, cmdArgs] = tryCmds[i];
    const child = spawn(cmd, cmdArgs, { env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => {
      const s = String(d);
      stdout += s;
      appendLog(s);
    });
    child.stderr?.on('data', (d) => {
      const s = String(d);
      stderr += s;
      appendLog(s);
    });
    child.on('error', () => runNext(i + 1));
    child.on('close', (code) => {
      if (
        i === 0 &&
        code !== 0 &&
        /password is required|a password is required|not allowed|No such file/i.test(stderr + stdout)
      ) {
        runNext(i + 1);
        return;
      }
      const finalCode = code ?? 1;
      tgJob = { ...tgJob, running: false, code: finalCode };
      onDone(finalCode);
    });
  };
  runNext(0);
  return { ok: true };
}

function parseStatusOutput(stdout: string): {
  status: string;
  installed: string;
  network: string;
  resources: number;
  dns: string;
  tun: string;
} {
  const status = (stdout.match(/^status=(.+)$/m) || [])[1]?.trim() || 'stopped';
  const installed = (stdout.match(/^installed=(.+)$/m) || [])[1]?.trim() || 'no';
  const network = (stdout.match(/^network=(.*)$/m) || [])[1]?.trim() || '';
  const resources = Number((stdout.match(/^resources=(.+)$/m) || [])[1]?.trim() || 0) || 0;
  const dns = (stdout.match(/^dns=(.+)$/m) || [])[1]?.trim() || 'unknown';
  const tun = (stdout.match(/^tun=(.+)$/m) || [])[1]?.trim() || (fs.existsSync('/dev/net/tun') ? 'yes' : 'unknown');
  return { status, installed, network, resources, dns, tun };
}

twingateRouter.get('/twingate/settings', (_req, res) => {
  const s = getTg();
  res.json({
    serviceKeySet: !!s.twingate_service_key,
    network: s.twingate_network || networkFromKey(s.twingate_service_key) || '',
    nodeName: s.twingate_node_name || '',
    status: s.twingate_status || 'stopped',
    enabled: !!s.twingate_enabled,
  });
});

twingateRouter.put('/twingate/settings', (req, res) => {
  const b = req.body || {};
  const cur = getTg();
  let key = cur.twingate_service_key;
  if (b.serviceKey != null && String(b.serviceKey).trim() !== '') {
    const raw = String(b.serviceKey).trim();
    try {
      const parsed = JSON.parse(raw);
      if (!parsed.network || !parsed.private_key) {
        return res.status(400).json({ error: 'Service Key JSON must include network and private_key.' });
      }
      key = JSON.stringify(parsed);
    } catch {
      return res.status(400).json({ error: 'Service Key must be valid JSON from the Twingate Admin Console.' });
    }
  }
  const nodeName = b.nodeName != null ? String(b.nodeName) : cur.twingate_node_name;
  const network = networkFromKey(key) || cur.twingate_network || '';
  db.prepare(
    `UPDATE app_settings SET twingate_service_key = ?, twingate_network = ?, twingate_node_name = ? WHERE id = 1`
  ).run(key, network, nodeName || null);
  db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
    'info',
    'twingate',
    'Twingate settings updated'
  );
  const s = getTg();
  res.json({
    serviceKeySet: !!s.twingate_service_key,
    network: s.twingate_network || '',
    nodeName: s.twingate_node_name || '',
    status: s.twingate_status || 'stopped',
    enabled: !!s.twingate_enabled,
  });
});

twingateRouter.get('/twingate', async (_req, res) => {
  const s = getTg();
  const configured = !!s.twingate_service_key;
  const result = await runTwingateScript(['status']);
  let live = {
    status: s.twingate_status || 'stopped',
    installed: 'no',
    network: s.twingate_network || networkFromKey(s.twingate_service_key) || '',
    resources: 0,
    dns: 'unknown',
    tun: fs.existsSync('/dev/net/tun') ? 'yes' : 'no',
  };
  if (result.code === 0) {
    live = { ...live, ...parseStatusOutput(result.stdout) };
    const enabled = live.status === 'online' || live.status === 'authenticating' ? 1 : 0;
    if (live.network) {
      db.prepare('UPDATE app_settings SET twingate_status = ?, twingate_network = ?, twingate_enabled = ? WHERE id = 1').run(
        live.status,
        live.network,
        enabled
      );
    } else {
      db.prepare('UPDATE app_settings SET twingate_status = ?, twingate_enabled = ? WHERE id = 1').run(live.status, enabled);
    }
  }
  const connecting = live.status === 'authenticating';
  const tunMissing = live.tun === 'no';
  res.json({
    configured,
    online: live.status === 'online',
    connecting,
    tunOk: !tunMissing,
    status: live.status,
    installed: live.installed === 'yes',
    network: live.network || s.twingate_network || '',
    nodeName: s.twingate_node_name || 'panel-host',
    resourceCount: live.resources,
    dns: live.dns,
    message: tunMissing
      ? 'Missing /dev/net/tun (common on Proxmox LXC). Twingate cannot start until TUN is enabled on the Proxmox host. Run: sudo bash scripts/proxmox-enable-twingate-tun.sh <CTID>  then reboot the CT and retry Install & connect.'
      : !configured
        ? 'Paste a Twingate Service Key (Admin Console → Services), then Install & connect. A Connector must be online on the remote LAN, and Resources must be granted to this Service Account.'
        : live.status === 'error'
          ? 'Twingate was rolled back because it broke host DNS/connectivity. Use Emergency restore if needed, fix Connector/Resources (avoid LAN CIDR overlap), then retry.'
          : connecting
            ? 'Client is authenticating (Service Key auth is automatic — there is no Accept button). In Twingate Admin: Connector Online + grant this Service Account Resources (specific remote IPs). Status refreshes automatically.'
            : live.status === 'not-running'
              ? 'Twingate client daemon is not running. If journalctl shows TUN errors, enable /dev/net/tun on the Proxmox host (scripts/proxmox-enable-twingate-tun.sh). Otherwise: sudo systemctl restart twingate && sudo journalctl -u twingate -n 50'
              : live.status !== 'online'
                ? 'Client is configured but not online. Use Install & connect, and confirm a Connector is online in Twingate Admin.'
                : live.resources === 0
                  ? 'Connected, but no Resources are assigned yet. Add specific OLT/router IPs in Twingate Admin (avoid broad CIDRs that overlap this panel LAN) and grant this Service Account access.'
                  : null,
    warning: result.code !== 0 ? result.stderr || undefined : undefined,
  });
});

twingateRouter.get('/twingate/job', (_req, res) => {
  let log = '';
  try {
    log = fs.readFileSync(TG_JOB_LOG, 'utf8').slice(-8000);
  } catch {
    /* none yet */
  }
  res.json({
    running: tgJob.running,
    action: tgJob.action,
    code: tgJob.code,
    startedAt: tgJob.startedAt,
    log,
  });
});

twingateRouter.get('/twingate/status', async (_req, res) => {
  const result = await runTwingateScript(['status']);
  const s = getTg();
  if (result.code === 0) {
    const parsed = parseStatusOutput(result.stdout);
    res.json({ ...parsed, configured: !!s.twingate_service_key, output: result.stdout.trim() });
    return;
  }
  res.json({
    status: s.twingate_status || 'stopped',
    installed: 'unknown',
    network: s.twingate_network || '',
    resources: 0,
    configured: !!s.twingate_service_key,
    warning: result.stderr || undefined,
  });
});

async function syncLiveStatusAfterJob(fallbackNet: string): Promise<{ status: string; resources: number }> {
  const result = await runTwingateScript(['status']);
  if (result.code === 0) {
    const parsed = parseStatusOutput(result.stdout);
    const enabled = parsed.status === 'online' || parsed.status === 'authenticating' ? 1 : 0;
    const net = parsed.network || fallbackNet;
    if (net) {
      db.prepare(
        'UPDATE app_settings SET twingate_status = ?, twingate_network = COALESCE(NULLIF(?, ""), twingate_network), twingate_enabled = ? WHERE id = 1'
      ).run(parsed.status, net, enabled);
    } else {
      db.prepare('UPDATE app_settings SET twingate_status = ?, twingate_enabled = ? WHERE id = 1').run(parsed.status, enabled);
    }
    return { status: parsed.status, resources: parsed.resources };
  }
  return { status: 'offline', resources: 0 };
}

twingateRouter.post('/twingate/apply', (_req, res) => {
  const s = getTg();
  if (!s.twingate_service_key) {
    return res.status(400).json({ error: 'Save your Twingate Service Key first.' });
  }
  // Node already has the key via better-sqlite3 — pass --key-file so the shell
  // helper never needs the sqlite3 CLI (apt mirrors often 404 on stale indexes).
  let keyPath: string;
  try {
    keyPath = writeTwingateKeyFile(s.twingate_service_key);
  } catch (e) {
    return res.status(500).json({ error: `Could not write Service Key file: ${(e as Error).message}` });
  }
  const net = networkFromKey(s.twingate_service_key);
  const started = startTwingateJob(['--key-file', keyPath, 'apply'], 'apply', (code) => {
    void (async () => {
      if (code === 0) {
        const live = await syncLiveStatusAfterJob(net);
        db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
          'info',
          'twingate',
          live.status === 'online'
            ? `Twingate connected${net ? ` (${net})` : ''}`
            : live.status === 'authenticating'
              ? `Twingate client authenticating${net ? ` (${net})` : ''} — waiting for Connector / Resources`
              : `Twingate apply finished with status=${live.status}`
        );
      } else {
        db.prepare('UPDATE app_settings SET twingate_status = ?, twingate_enabled = 0 WHERE id = 1').run('error');
        db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
          'error',
          'twingate',
          `Twingate apply failed or rolled back to protect panel connectivity (exit ${code})`
        );
      }
    })();
  });
  if (!started.ok) return res.status(409).json({ error: started.error });
  res.json({ ok: true, started: true });
});

twingateRouter.post('/twingate/toggle', (_req, res) => {
  const s = getTg();
  const running = s.twingate_status === 'online' || s.twingate_status === 'authenticating';
  if (!running) {
    if (!s.twingate_service_key) {
      return res.status(400).json({ error: 'Save your Twingate Service Key first.' });
    }
    // Prefer full apply (installs client if missing); fall back to plain start.
    let keyPath: string;
    try {
      keyPath = writeTwingateKeyFile(s.twingate_service_key);
    } catch (e) {
      return res.status(500).json({ error: `Could not write Service Key file: ${(e as Error).message}` });
    }
    const net = networkFromKey(s.twingate_service_key);
    const onStarted = (code: number) => {
      void (async () => {
        if (code === 0) {
          const live = await syncLiveStatusAfterJob(net);
          db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
            'info',
            'twingate',
            live.status === 'online'
              ? 'Twingate started'
              : live.status === 'authenticating'
                ? 'Twingate started — still authenticating (check Connector / Resources)'
                : `Twingate start finished with status=${live.status}`
          );
        } else {
          db.prepare('UPDATE app_settings SET twingate_status = ?, twingate_enabled = 0 WHERE id = 1').run(
            code === 1 ? 'error' : 'offline'
          );
          db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
            'error',
            'twingate',
            `Twingate start failed or rolled back to protect panel connectivity (exit ${code})`
          );
        }
      })();
    };
    const started = startTwingateJob(['--key-file', keyPath, 'apply'], 'start', (code) => {
      if (code === 0) {
        onStarted(0);
        return;
      }
      const retried = startTwingateJob(['start'], 'start', onStarted);
      if (!retried.ok) onStarted(code);
    });
    if (!started.ok) return res.status(409).json({ error: started.error });
    return res.json({ ok: true, started: true, action: 'start' });
  }
  const started = startTwingateJob(['stop'], 'stop', (code) => {
    db.prepare('UPDATE app_settings SET twingate_status = ?, twingate_enabled = 0 WHERE id = 1').run(
      code === 0 ? 'stopped' : s.twingate_status || 'offline'
    );
    db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
      code === 0 ? 'info' : 'error',
      'twingate',
      code === 0 ? 'Twingate stopped (DNS restored)' : `Twingate stop failed (exit ${code})`
    );
  });
  if (!started.ok) return res.status(409).json({ error: started.error });
  res.json({ ok: true, started: true, action: 'stop' });
});

/** Force-stop Twingate and restore host DNS — recovery when panel looks "disconnected". */
twingateRouter.post('/twingate/emergency-restore', (_req, res) => {
  const started = startTwingateJob(['emergency-restore'], 'emergency-restore', (code) => {
    db.prepare('UPDATE app_settings SET twingate_status = ?, twingate_enabled = 0 WHERE id = 1').run(
      code === 0 ? 'stopped' : 'error'
    );
    db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
      code === 0 ? 'warn' : 'error',
      'twingate',
      code === 0
        ? 'Emergency restore: Twingate stopped and host DNS restored'
        : `Emergency restore failed (exit ${code})`
    );
  });
  if (!started.ok) return res.status(409).json({ error: started.error });
  res.json({ ok: true, started: true, action: 'emergency-restore' });
});

function coexistScriptPath(): string {
  const candidates = [
    path.join(
      process.env.INSTALL_DIR || process.env.var_install_dir || '/opt/mt-billing',
      'install/mt-billing-net-coexist.sh'
    ),
    path.resolve(process.cwd(), '../install/mt-billing-net-coexist.sh'),
    path.resolve(process.cwd(), 'install/mt-billing-net-coexist.sh'),
    path.resolve(process.cwd(), '../../install/mt-billing-net-coexist.sh'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
}

function startCoexistJob(onDone: (code: number) => void): { ok: boolean; error?: string } {
  if (tgJob.running) {
    return { ok: false, error: `A Twingate operation (${tgJob.action}) is already running.` };
  }
  const script = coexistScriptPath();
  tgJob = { running: true, action: 'coexist', code: null, startedAt: Date.now() };
  try {
    fs.writeFileSync(TG_JOB_LOG, `$ sudo bash ${script} apply\n`);
  } catch {
    /* ignore */
  }
  const tryCmds = [
    ['sudo', ['-n', '/bin/bash', script, 'apply']],
    ['sudo', ['-n', '/usr/bin/bash', script, 'apply']],
    ['bash', [script, 'apply']],
  ] as [string, string[]][];
  const appendLog = (s: string) => {
    try {
      fs.appendFileSync(TG_JOB_LOG, stripAnsi(s));
    } catch {
      /* ignore */
    }
  };
  const runNext = (i: number) => {
    if (i >= tryCmds.length) {
      appendLog('\nCould not run net-coexist helper. Grant updater root, then retry.\n');
      tgJob = { ...tgJob, running: false, code: 127 };
      onDone(127);
      return;
    }
    const [cmd, cmdArgs] = tryCmds[i];
    const child = spawn(cmd, cmdArgs, { env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => {
      const s = String(d);
      stdout += s;
      appendLog(s);
    });
    child.stderr?.on('data', (d) => {
      const s = String(d);
      stderr += s;
      appendLog(s);
    });
    child.on('error', () => runNext(i + 1));
    child.on('close', (code) => {
      if (
        i === 0 &&
        code !== 0 &&
        /password is required|a password is required|not allowed|No such file/i.test(stderr + stdout)
      ) {
        runNext(i + 1);
        return;
      }
      const finalCode = code ?? 1;
      tgJob = { ...tgJob, running: false, code: finalCode };
      onDone(finalCode);
    });
  };
  runNext(0);
  return { ok: true };
}

/** Re-apply LAN pin + coexist DNS so Cloudflare Tunnel and Twingate don't fight the local network. */
twingateRouter.post('/twingate/coexist', (_req, res) => {
  const started = startCoexistJob((code) => {
    db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
      code === 0 ? 'info' : 'error',
      'twingate',
      code === 0
        ? 'Applied Cloudflare + Twingate network coexistence'
        : `Coexistence apply failed (exit ${code})`
    );
  });
  if (!started.ok) return res.status(409).json({ error: started.error });
  res.json({ ok: true, started: true, action: 'coexist' });
});

twingateRouter.get('/twingate/coexist', (_req, res) => {
  const script = coexistScriptPath();
  if (!fs.existsSync(script)) {
    return res.json({ ok: false, error: 'coexist script missing' });
  }
  const child = spawn('bash', [script, 'status'], { env: process.env });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d) => {
    stdout += String(d);
  });
  child.stderr?.on('data', (d) => {
    stderr += String(d);
  });
  child.on('close', (code) => {
    const parsed: Record<string, string> = {};
    for (const line of stdout.split('\n')) {
      const m = line.match(/^([^=]+)=(.*)$/);
      if (m) parsed[m[1]] = m[2];
    }
    res.json({ ok: code === 0, ...parsed, raw: stdout.trim(), warning: stderr || undefined });
  });
  child.on('error', () => {
    res.json({ ok: false, error: 'failed to run coexist status' });
  });
});
