/**
 * Scheduled full SQLite backups with retention.
 */
import fs from 'fs';
import path from 'path';
import { db, backupsDir } from './db.js';
import { getBackupAutoSettings, ensurePaymongoColumns } from './paymongo.js';

let started = false;
let lastRunMs = 0;

export async function runAutoBackupOnce(): Promise<{ ok: boolean; file?: string; pruned?: number; detail?: string }> {
  ensurePaymongoColumns();
  const s = getBackupAutoSettings();
  if (!s.enabled) return { ok: false, detail: 'auto-backup disabled' };

  if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(backupsDir, `auto-backup-${stamp}.db`);
  await db.backup(file);
  db.prepare(`UPDATE app_settings SET backup_last_at = datetime('now') WHERE id = 1`).run();
  db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
    'info',
    'backup',
    `Auto-backup saved: ${path.basename(file)}`
  );

  // Retention: keep newest N auto-backup-*.db files
  const files = fs
    .readdirSync(backupsDir)
    .filter((f) => f.startsWith('auto-backup-') && f.endsWith('.db'))
    .map((f) => ({ f, t: fs.statSync(path.join(backupsDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  let pruned = 0;
  for (const extra of files.slice(Math.max(1, s.retainCount))) {
    try {
      fs.unlinkSync(path.join(backupsDir, extra.f));
      pruned++;
    } catch {
      /* ignore */
    }
  }
  lastRunMs = Date.now();
  return { ok: true, file: path.basename(file), pruned };
}

export function startAutoBackupScheduler(checkEveryMs = 15 * 60 * 1000) {
  if (started) return;
  started = true;
  const tick = async () => {
    try {
      ensurePaymongoColumns();
      const s = getBackupAutoSettings();
      if (!s.enabled) return;
      const everyMs = Math.max(1, s.everyHours) * 60 * 60 * 1000;
      const lastAt = s.lastAt ? Date.parse(s.lastAt) : 0;
      const due = !lastAt || Date.now() - lastAt >= everyMs;
      // Also respect in-process lastRun to avoid double-fire
      if (due && Date.now() - lastRunMs >= Math.min(everyMs, 10 * 60 * 1000)) {
        await runAutoBackupOnce();
      }
    } catch (e: any) {
      try {
        db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
          'warning',
          'backup',
          `Auto-backup failed: ${e?.message || e}`
        );
      } catch {
        /* ignore */
      }
    }
  };
  setTimeout(() => void tick(), 120_000);
  setInterval(() => void tick(), checkEveryMs);
}
