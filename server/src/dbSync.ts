/**
 * Hub ↔ Edge (local PC) database sync.
 *
 * - Hub: central server; serves pull snapshots and accepts edge pushes.
 * - Edge: local PC install; works offline on its own SQLite; queues changes
 *   in sync_outbox until the hub is reachable, then pushes latest rows and
 *   pulls hub data (same “hold until online / get latest” idea as router_sync_queue).
 */
import crypto from 'crypto';
import { db } from './db.js';

export type SyncRole = 'standalone' | 'hub' | 'edge';

/** Tables grouped for sync snapshots (mirrors selective backup categories + a few extras). */
export const SYNC_CATEGORIES: Record<string, string[]> = {
  settings: ['app_settings', 'company', 'users', 'notify_settings', 'fair_use_settings'],
  clients: ['pppoe_users', 'profiles', 'ipoe_profiles', 'ipoe_plans', 'ipoe_lease_meta'],
  network: ['routers', 'naps', 'splitters', 'splitter_loss_reference', 'noc_devices', 'queues'],
  reports: ['transactions', 'payment_links', 'invoices', 'invoice_payments', 'expenses'],
  operations: ['notifications', 'job_orders', 'ai_scripts', 'inventory', 'usage_alerts'],
  portal: [
    'payment_merchants',
    'outage_subscriber_reports',
    'outage_subscriber_report_services',
    'plan_change_requests',
  ],
};

type SyncSettings = {
  role: SyncRole;
  enabled: boolean;
  hubUrl: string;
  token: string;
  deviceId: string;
  deviceName: string;
  lastPullAt: string | null;
  lastPushAt: string | null;
  lastError: string | null;
  lastStatus: string | null;
  pendingCount: number;
};

const SYNC_TABLES = (): string[] => {
  const set = new Set<string>();
  for (const tables of Object.values(SYNC_CATEGORIES)) {
    for (const t of tables) set.add(t);
  }
  return [...set];
};

function columnExists(table: string, col: string): boolean {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return rows.some((r) => r.name === col);
  } catch {
    return false;
  }
}

function tableExists(name: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name) as { ok: number } | undefined;
  return Boolean(row?.ok);
}

export function initDbSync() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      op TEXT NOT NULL DEFAULT 'upsert',
      payload TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      next_attempt_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (entity_type, entity_id)
    );
    CREATE INDEX IF NOT EXISTS idx_sync_outbox_next ON sync_outbox(next_attempt_at);

    CREATE TABLE IF NOT EXISTS sync_peers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT UNIQUE NOT NULL,
      device_name TEXT,
      last_seen_at TEXT,
      last_pull_at TEXT,
      last_push_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const cols: [string, string][] = [
    ['sync_role', "TEXT DEFAULT 'standalone'"],
    ['sync_enabled', 'INTEGER DEFAULT 0'],
    ['sync_hub_url', 'TEXT'],
    ['sync_token', 'TEXT'],
    ['sync_device_id', 'TEXT'],
    ['sync_device_name', 'TEXT'],
    ['sync_last_pull_at', 'TEXT'],
    ['sync_last_push_at', 'TEXT'],
    ['sync_last_error', 'TEXT'],
    ['sync_last_status', 'TEXT'],
  ];
  for (const [col, type] of cols) {
    if (!columnExists('app_settings', col)) {
      try {
        db.exec(`ALTER TABLE app_settings ADD COLUMN ${col} ${type}`);
      } catch {
        /* ignore */
      }
    }
  }

  const s = db.prepare('SELECT sync_device_id, sync_token FROM app_settings WHERE id = 1').get() as
    | { sync_device_id?: string; sync_token?: string }
    | undefined;
  if (s && !s.sync_device_id) {
    db.prepare('UPDATE app_settings SET sync_device_id = ? WHERE id = 1').run(crypto.randomBytes(12).toString('hex'));
  }
  if (s && !s.sync_token) {
    db.prepare('UPDATE app_settings SET sync_token = ? WHERE id = 1').run(crypto.randomBytes(24).toString('hex'));
  }

  ensureSyncTriggers();
}

function ensureSyncTriggers() {
  // Edge nodes enqueue row snapshots; hub/standalone keep triggers but enqueue is no-op unless edge+enabled.
  for (const table of SYNC_TABLES()) {
    if (!tableExists(table)) continue;
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; pk: number }[];
    if (!cols.length) continue;
    const pk = cols.find((c) => c.pk === 1)?.name || cols[0].name;
    const triggerBase = `sync_outbox_${table}`.replace(/[^a-zA-Z0-9_]/g, '_');
    try {
      db.exec(`DROP TRIGGER IF EXISTS ${triggerBase}_ai`);
      db.exec(`DROP TRIGGER IF EXISTS ${triggerBase}_au`);
      db.exec(`DROP TRIGGER IF EXISTS ${triggerBase}_ad`);
    } catch {
      /* ignore */
    }
    // Upsert into outbox with JSON of NEW row (or delete marker). Only fires useful work when edge+enabled (checked at flush time).
    const colList = cols.map((c) => c.name);
    const jsonObject = colList.map((c) => `'${c}', NEW.${c}`).join(', ');
    try {
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS ${triggerBase}_ai AFTER INSERT ON ${table}
        WHEN (SELECT sync_enabled FROM app_settings WHERE id = 1) = 1
         AND (SELECT sync_role FROM app_settings WHERE id = 1) = 'edge'
        BEGIN
          INSERT INTO sync_outbox (entity_type, entity_id, op, payload, updated_at, next_attempt_at)
          VALUES ('${table}', CAST(NEW.${pk} AS TEXT), 'upsert',
            json_object(${jsonObject}), datetime('now'), datetime('now'))
          ON CONFLICT(entity_type, entity_id) DO UPDATE SET
            op='upsert',
            payload=excluded.payload,
            updated_at=datetime('now'),
            next_attempt_at=datetime('now'),
            last_error=NULL;
        END;
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS ${triggerBase}_au AFTER UPDATE ON ${table}
        WHEN (SELECT sync_enabled FROM app_settings WHERE id = 1) = 1
         AND (SELECT sync_role FROM app_settings WHERE id = 1) = 'edge'
        BEGIN
          INSERT INTO sync_outbox (entity_type, entity_id, op, payload, updated_at, next_attempt_at)
          VALUES ('${table}', CAST(NEW.${pk} AS TEXT), 'upsert',
            json_object(${jsonObject}), datetime('now'), datetime('now'))
          ON CONFLICT(entity_type, entity_id) DO UPDATE SET
            op='upsert',
            payload=excluded.payload,
            updated_at=datetime('now'),
            next_attempt_at=datetime('now'),
            last_error=NULL;
        END;
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS ${triggerBase}_ad AFTER DELETE ON ${table}
        WHEN (SELECT sync_enabled FROM app_settings WHERE id = 1) = 1
         AND (SELECT sync_role FROM app_settings WHERE id = 1) = 'edge'
        BEGIN
          INSERT INTO sync_outbox (entity_type, entity_id, op, payload, updated_at, next_attempt_at)
          VALUES ('${table}', CAST(OLD.${pk} AS TEXT), 'delete', NULL, datetime('now'), datetime('now'))
          ON CONFLICT(entity_type, entity_id) DO UPDATE SET
            op='delete',
            payload=NULL,
            updated_at=datetime('now'),
            next_attempt_at=datetime('now'),
            last_error=NULL;
        END;
      `);
    } catch (e) {
      // Some tables may use types sqlite json_object rejects; skip quietly.
      console.warn(`[sync] trigger skip ${table}:`, (e as Error)?.message || e);
    }
  }
}

function getRawSettings() {
  return db.prepare('SELECT * FROM app_settings WHERE id = 1').get() as any;
}

export function getSyncSettings(): SyncSettings {
  initDbSync();
  const s = getRawSettings() || {};
  const pending = db.prepare(`SELECT COUNT(*) AS c FROM sync_outbox`).get() as { c: number };
  return {
    role: (['standalone', 'hub', 'edge'].includes(String(s.sync_role)) ? s.sync_role : 'standalone') as SyncRole,
    enabled: Number(s.sync_enabled) === 1,
    hubUrl: String(s.sync_hub_url || '').replace(/\/$/, ''),
    token: String(s.sync_token || ''),
    deviceId: String(s.sync_device_id || ''),
    deviceName: String(s.sync_device_name || '') || `pc-${String(s.sync_device_id || '').slice(0, 6)}`,
    lastPullAt: s.sync_last_pull_at || null,
    lastPushAt: s.sync_last_push_at || null,
    lastError: s.sync_last_error || null,
    lastStatus: s.sync_last_status || null,
    pendingCount: Number(pending?.c) || 0,
  };
}

export function updateSyncSettings(patch: Partial<{
  role: SyncRole;
  enabled: boolean;
  hubUrl: string;
  token: string;
  deviceName: string;
}>) {
  initDbSync();
  const cur = getSyncSettings();
  const role = patch.role ?? cur.role;
  const enabled = patch.enabled ?? cur.enabled;
  const hubUrl = patch.hubUrl !== undefined ? String(patch.hubUrl || '').replace(/\/$/, '') : cur.hubUrl;
  const token = patch.token !== undefined ? String(patch.token || '').trim() : cur.token;
  const deviceName = patch.deviceName !== undefined ? String(patch.deviceName || '').trim() : cur.deviceName;
  db.prepare(
    `UPDATE app_settings SET
       sync_role = ?, sync_enabled = ?, sync_hub_url = ?, sync_token = ?, sync_device_name = ?
     WHERE id = 1`
  ).run(role, enabled ? 1 : 0, hubUrl || null, token || null, deviceName || null);
  return getSyncSettings();
}

export function rotateSyncToken() {
  initDbSync();
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('UPDATE app_settings SET sync_token = ? WHERE id = 1').run(token);
  return getSyncSettings();
}

function setSyncMeta(patch: { lastPullAt?: string; lastPushAt?: string; lastError?: string | null; lastStatus?: string }) {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.lastPullAt !== undefined) {
    sets.push('sync_last_pull_at = ?');
    vals.push(patch.lastPullAt);
  }
  if (patch.lastPushAt !== undefined) {
    sets.push('sync_last_push_at = ?');
    vals.push(patch.lastPushAt);
  }
  if (patch.lastError !== undefined) {
    sets.push('sync_last_error = ?');
    vals.push(patch.lastError);
  }
  if (patch.lastStatus !== undefined) {
    sets.push('sync_last_status = ?');
    vals.push(patch.lastStatus);
  }
  if (!sets.length) return;
  vals.push(1);
  db.prepare(`UPDATE app_settings SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

/** Build a selective snapshot of syncable tables (for pull / bootstrap). */
export function buildSyncSnapshot(categories?: string[]) {
  initDbSync();
  const cats =
    categories && categories.length
      ? categories.filter((c) => SYNC_CATEGORIES[c])
      : Object.keys(SYNC_CATEGORIES);
  const tables = new Set<string>();
  for (const c of cats) for (const t of SYNC_CATEGORIES[c] || []) tables.add(t);
  const data: Record<string, unknown[]> = {};
  const included: string[] = [];
  for (const table of tables) {
    if (!tableExists(table)) continue;
    try {
      data[table] = db.prepare(`SELECT * FROM ${table}`).all() as unknown[];
      included.push(table);
    } catch {
      /* skip */
    }
  }
  return {
    version: 1,
    kind: 'mt-billing-sync',
    at: new Date().toISOString(),
    categories: cats,
    tables: included,
    data,
  };
}

function pkColumn(table: string): string | null {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; pk: number }[];
  return cols.find((c) => c.pk === 1)?.name || cols[0]?.name || null;
}

/** Apply upsert/delete changes (merge — does not wipe whole tables). */
export function applySyncChanges(
  changes: { entityType: string; entityId: string; op: string; payload?: Record<string, unknown> | null }[]
) {
  initDbSync();
  let applied = 0;
  const tx = db.transaction(() => {
    // Temporarily disable outbox triggers flooding while applying remote changes
    db.exec('PRAGMA recursive_triggers = OFF');
    for (const ch of changes) {
      const table = String(ch.entityType || '');
      if (!tableExists(table)) continue;
      const pk = pkColumn(table);
      if (!pk) continue;
      if (ch.op === 'delete') {
        db.prepare(`DELETE FROM ${table} WHERE ${pk} = ?`).run(ch.entityId);
        applied += 1;
        continue;
      }
      const row = ch.payload;
      if (!row || typeof row !== 'object') continue;
      const colsInfo = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      const colNames = colsInfo.map((c) => c.name).filter((c) => c in row);
      if (!colNames.length) continue;
      const placeholders = colNames.map(() => '?').join(',');
      const updates = colNames.filter((c) => c !== pk).map((c) => `${c}=excluded.${c}`).join(',');
      const sql = updates
        ? `INSERT INTO ${table} (${colNames.join(',')}) VALUES (${placeholders})
           ON CONFLICT(${pk}) DO UPDATE SET ${updates}`
        : `INSERT OR IGNORE INTO ${table} (${colNames.join(',')}) VALUES (${placeholders})`;
      try {
        db.prepare(sql).run(...colNames.map((c) => (row as any)[c] ?? null));
        applied += 1;
      } catch (e) {
        console.warn(`[sync] apply ${table}/${ch.entityId}:`, (e as Error)?.message || e);
      }
    }
  });
  tx();
  // Clear outbox rows that were just applied from remote to avoid echo loops
  return { applied };
}

/** Apply a full category snapshot with upsert merge (hub → edge pull). */
export function applySyncSnapshot(snapshot: { data?: Record<string, unknown[]> }) {
  initDbSync();
  const data = snapshot?.data || {};
  const localSync = getRawSettings() || {};
  let tables = 0;
  let rows = 0;
  const tx = db.transaction(() => {
    for (const [table, list] of Object.entries(data)) {
      if (!tableExists(table) || !Array.isArray(list)) continue;
      const pk = pkColumn(table);
      if (!pk) continue;
      const colsInfo = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      let colNames = colsInfo.map((c) => c.name);
      // Never let hub overwrite this node's sync identity / role
      if (table === 'app_settings') {
        colNames = colNames.filter((c) => !c.startsWith('sync_'));
      }
      if (!colNames.length) continue;
      const placeholders = colNames.map(() => '?').join(',');
      const updates = colNames.filter((c) => c !== pk).map((c) => `${c}=excluded.${c}`).join(',');
      const sql = updates
        ? `INSERT INTO ${table} (${colNames.join(',')}) VALUES (${placeholders})
           ON CONFLICT(${pk}) DO UPDATE SET ${updates}`
        : `INSERT OR IGNORE INTO ${table} (${colNames.join(',')}) VALUES (${placeholders})`;
      const ins = db.prepare(sql);
      for (const row of list as Record<string, unknown>[]) {
        try {
          ins.run(...colNames.map((c) => (row[c] !== undefined ? row[c] : null)));
          rows += 1;
        } catch {
          /* skip bad row */
        }
      }
      tables += 1;
    }
    // Restore local sync_* columns after app_settings merge
    if (data.app_settings) {
      db.prepare(
        `UPDATE app_settings SET
           sync_role = ?, sync_enabled = ?, sync_hub_url = ?, sync_token = ?,
           sync_device_id = ?, sync_device_name = ?,
           sync_last_pull_at = ?, sync_last_push_at = ?, sync_last_error = ?, sync_last_status = ?
         WHERE id = 1`
      ).run(
        localSync.sync_role,
        localSync.sync_enabled,
        localSync.sync_hub_url,
        localSync.sync_token,
        localSync.sync_device_id,
        localSync.sync_device_name,
        localSync.sync_last_pull_at,
        localSync.sync_last_push_at,
        localSync.sync_last_error,
        localSync.sync_last_status
      );
    }
  });
  tx();
  return { tables, rows };
}

export function listOutbox(limit = 200) {
  initDbSync();
  return db
    .prepare(
      `SELECT id, entity_type AS entityType, entity_id AS entityId, op, payload, updated_at AS updatedAt,
              attempts, last_error AS lastError, next_attempt_at AS nextAttemptAt
       FROM sync_outbox ORDER BY id ASC LIMIT ?`
    )
    .all(limit) as any[];
}

function parsePayload(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function backoffMinutes(attempts: number) {
  return Math.min(30, Math.max(1, 2 ** Math.min(attempts, 4)));
}

export function markOutboxFailed(ids: number[], error: string) {
  const stmt = db.prepare(
    `UPDATE sync_outbox SET attempts = attempts + 1, last_error = ?,
       next_attempt_at = datetime('now', '+' || ? || ' minutes') WHERE id = ?`
  );
  const tx = db.transaction(() => {
    for (const id of ids) {
      const row = db.prepare('SELECT attempts FROM sync_outbox WHERE id = ?').get(id) as { attempts: number } | undefined;
      const mins = backoffMinutes(Number(row?.attempts || 0) + 1);
      stmt.run(error.slice(0, 400), mins, id);
    }
  });
  tx();
}

export function clearOutbox(ids: number[]) {
  if (!ids.length) return;
  const del = db.prepare('DELETE FROM sync_outbox WHERE id = ?');
  const tx = db.transaction(() => {
    for (const id of ids) del.run(id);
  });
  tx();
}

export function touchPeer(deviceId: string, deviceName: string, kind: 'pull' | 'push') {
  initDbSync();
  db.prepare(
    `INSERT INTO sync_peers (device_id, device_name, last_seen_at, last_pull_at, last_push_at)
     VALUES (?, ?, datetime('now'), ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET
       device_name=excluded.device_name,
       last_seen_at=datetime('now'),
       last_pull_at=CASE WHEN ?='pull' THEN datetime('now') ELSE sync_peers.last_pull_at END,
       last_push_at=CASE WHEN ?='push' THEN datetime('now') ELSE sync_peers.last_push_at END`
  ).run(
    deviceId,
    deviceName || null,
    kind === 'pull' ? new Date().toISOString() : null,
    kind === 'push' ? new Date().toISOString() : null,
    kind,
    kind
  );
}

export function listPeers() {
  initDbSync();
  return db
    .prepare(
      `SELECT id, device_id AS deviceId, device_name AS deviceName, last_seen_at AS lastSeenAt,
              last_pull_at AS lastPullAt, last_push_at AS lastPushAt, created_at AS createdAt
       FROM sync_peers ORDER BY last_seen_at DESC`
    )
    .all();
}

export function assertSyncToken(headerToken: string | undefined | null) {
  const s = getSyncSettings();
  const expected = String(s.token || '');
  const got = String(headerToken || '').replace(/^Bearer\s+/i, '').trim();
  if (!expected || !got || expected !== got) {
    const err = new Error('Invalid sync token');
    (err as any).status = 401;
    throw err;
  }
  if (!s.enabled || s.role !== 'hub') {
    const err = new Error('This node is not accepting sync (set role to Hub and enable sync)');
    (err as any).status = 403;
    throw err;
  }
}

async function fetchHub(path: string, opts: RequestInit & { token: string; hubUrl: string }) {
  const url = `${opts.hubUrl.replace(/\/$/, '')}${path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.token}`,
        'X-Sync-Device-Id': getSyncSettings().deviceId,
        'X-Sync-Device-Name': getSyncSettings().deviceName,
        ...(opts.headers || {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Hub HTTP ${res.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** Edge sync cycle: pull latest from hub, then push held outbox rows. */
export async function runEdgeSyncCycle(force = false): Promise<{
  ok: boolean;
  pulled?: number;
  pushed?: number;
  pending: number;
  error?: string;
  online: boolean;
}> {
  initDbSync();
  const s = getSyncSettings();
  if (!s.enabled || s.role !== 'edge') {
    return { ok: false, pending: s.pendingCount, online: false, error: 'Edge sync not enabled' };
  }
  if (!s.hubUrl || !s.token) {
    return { ok: false, pending: s.pendingCount, online: false, error: 'Set hub URL and sync token' };
  }

  try {
    await fetchHub('/api/sync/hello', { method: 'GET', hubUrl: s.hubUrl, token: s.token });
  } catch (e: any) {
    const msg = e?.name === 'AbortError' ? 'Hub unreachable (timeout)' : e?.message || 'Hub offline';
    setSyncMeta({ lastError: msg, lastStatus: 'offline — holding local changes' });
    return { ok: false, pending: getSyncSettings().pendingCount, online: false, error: msg };
  }

  let pulled = 0;
  let pushed = 0;
  try {
    // 1) Pull latest snapshot from hub
    const pull = await fetchHub('/api/sync/pull', { method: 'GET', hubUrl: s.hubUrl, token: s.token });
    if (pull?.snapshot) {
      const r = applySyncSnapshot(pull.snapshot);
      pulled = r.rows;
      setSyncMeta({ lastPullAt: new Date().toISOString() });
    }

    // 2) Push held outbox (latest row state)
    const due = db
      .prepare(
        force
          ? `SELECT * FROM sync_outbox ORDER BY id ASC LIMIT 500`
          : `SELECT * FROM sync_outbox WHERE datetime(next_attempt_at) <= datetime('now') ORDER BY id ASC LIMIT 500`
      )
      .all() as any[];
    if (due.length) {
      const changes = due.map((r) => ({
        entityType: r.entity_type,
        entityId: String(r.entity_id),
        op: r.op,
        payload: parsePayload(r.payload),
      }));
      await fetchHub('/api/sync/push', {
        method: 'POST',
        hubUrl: s.hubUrl,
        token: s.token,
        body: JSON.stringify({
          deviceId: s.deviceId,
          deviceName: s.deviceName,
          changes,
        }),
      });
      clearOutbox(due.map((r) => Number(r.id)));
      pushed = due.length;
      setSyncMeta({ lastPushAt: new Date().toISOString() });
    }

    setSyncMeta({ lastError: null, lastStatus: 'online — synced' });
    return { ok: true, pulled, pushed, pending: getSyncSettings().pendingCount, online: true };
  } catch (e: any) {
    const msg = e?.message || 'Sync failed';
    const dueIds = (
      db.prepare(`SELECT id FROM sync_outbox WHERE datetime(next_attempt_at) <= datetime('now') LIMIT 500`).all() as {
        id: number;
      }[]
    ).map((r) => r.id);
    if (dueIds.length) markOutboxFailed(dueIds, msg);
    setSyncMeta({ lastError: msg, lastStatus: 'error — holding local changes' });
    return { ok: false, pulled, pushed, pending: getSyncSettings().pendingCount, online: true, error: msg };
  }
}

let syncTimer: ReturnType<typeof setTimeout> | null = null;
let syncRunning = false;

export function startDbSyncScheduler(intervalMs = 2 * 60 * 1000) {
  initDbSync();
  if (syncTimer) clearTimeout(syncTimer);
  const tick = async () => {
    if (!syncRunning) {
      const s = getSyncSettings();
      if (s.enabled && s.role === 'edge') {
        syncRunning = true;
        try {
          await runEdgeSyncCycle(false);
        } catch (e) {
          console.warn('[sync] cycle error', e);
        } finally {
          syncRunning = false;
        }
      }
    }
    syncTimer = setTimeout(tick, intervalMs);
  };
  // First attempt shortly after boot so a newly online PC catches up
  syncTimer = setTimeout(tick, Math.min(20_000, intervalMs));
}
