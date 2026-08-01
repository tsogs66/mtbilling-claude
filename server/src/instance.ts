/**
 * Panel instance fingerprint — used to detect when LAN IP and Cloudflare
 * hostname are backed by different machines / databases.
 */
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { db, dbPath } from './db.js';

export type InstanceFingerprint = {
  hostname: string;
  pid: number;
  dbPath: string;
  dbMtimeMs: number | null;
  dbBytes: number | null;
  pppoeUsers: number;
  routers: number;
  nocDevices: number;
  /** Short stable id from hostname + db path (not secret). */
  id: string;
};

export function getInstanceFingerprint(): InstanceFingerprint {
  let dbMtimeMs: number | null = null;
  let dbBytes: number | null = null;
  try {
    const st = fs.statSync(dbPath);
    dbMtimeMs = st.mtimeMs;
    dbBytes = st.size;
  } catch {
    /* ignore */
  }

  let pppoeUsers = 0;
  let routers = 0;
  let nocDevices = 0;
  try {
    pppoeUsers = Number((db.prepare('SELECT COUNT(*) AS c FROM pppoe_users').get() as { c: number })?.c || 0);
  } catch {
    /* ignore */
  }
  try {
    routers = Number((db.prepare('SELECT COUNT(*) AS c FROM routers').get() as { c: number })?.c || 0);
  } catch {
    /* ignore */
  }
  try {
    nocDevices = Number((db.prepare('SELECT COUNT(*) AS c FROM noc_devices').get() as { c: number })?.c || 0);
  } catch {
    /* ignore */
  }

  const hostname = os.hostname();
  const id = crypto
    .createHash('sha256')
    .update(`${hostname}|${dbPath}`)
    .digest('hex')
    .slice(0, 12);

  return {
    hostname,
    pid: process.pid,
    dbPath,
    dbMtimeMs,
    dbBytes,
    pppoeUsers,
    routers,
    nocDevices,
    id,
  };
}

export function fingerprintsMatch(
  a: Partial<InstanceFingerprint> | null | undefined,
  b: Partial<InstanceFingerprint> | null | undefined
): boolean {
  if (!a || !b) return false;
  if (a.id && b.id) return a.id === b.id;
  return (
    a.hostname === b.hostname &&
    a.pppoeUsers === b.pppoeUsers &&
    a.routers === b.routers &&
    a.nocDevices === b.nocDevices &&
    a.dbBytes === b.dbBytes
  );
}
