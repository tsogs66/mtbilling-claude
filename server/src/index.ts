import 'dotenv/config';
import http from 'http';
import os from 'os';
import fs from 'fs';
import path from 'path';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import si from 'systeminformation';
import { db, initSchema, seed, migrate } from './db.js';
import { signToken, requireAuth, sessionPayload, requireLicenseOrAllowlist, requireRoleWritable, type AuthedRequest } from './auth.js';
import { panelHardwareId, expectedPasswordResetCode, normalizeCode } from './panelId.js';
import {
  tryLiveResource,
  withRouter,
  probeRouter,
  fetchWanRoutes,
  listRouterFiles,
  fetchRouterDashboardStats,
  fetchRouterQueues,
  fetchRouterInterfaceNames,
  fetchRouterInterfaceTraffic,
  fetchPppSecrets,
  fetchPppActive,
  fetchPppSecretsAndActive,
  enrichPppUsersFromLive,
  pppNameKey,
  isSystemPppProfileName,
  fetchPppProfiles,
  addPppProfile,
  updatePppProfile,
  removePppProfile,
  setPppSecretEnabled,
  removePppActiveByName,
  addPppSecret,
  updatePppSecret,
  removePppSecret,
  buildPppSecretComment,
  fetchPppoeServers,
  fetchDhcpLeases,
  fetchDhcpServers,
  addDhcpServer,
  updateDhcpServer,
  removeDhcpServer,
  setDhcpLeaseBlocked,
  fetchPppActiveTraffic,
  fetchLeaseTrafficByIp,
} from './mikrotik.js';
import { probeOlt } from './olt.js';
import { getUptime, getUptimeSummary, runUptimeChecks, startUptime, getUptimeScopes, getActiveScope, setActiveScope, setActiveRouterId, type UptimeScope } from './uptime.js';
import {
  startStatusHub,
  listStatusOverview,
  listUplinkOverview,
  runStatusChecks,
  runUplinkChecks,
  createMonitor,
  deleteMonitor,
  setMonitorEnabled,
  createUplinkHost,
  deleteUplinkHost,
  prometheusMetrics,
  setStatusHubRouterId,
} from './statusHub.js';
import {
  startOutageMonitor,
  listOutageOverview,
  getOutageService,
  runOutageSweep,
} from './outageMonitor.js';
import {
  recordPppoePayment,
  getTransactionReceipt,
  createPaymentLink,
  submitPaymentProof,
  rejectPaymentProof,
  getPaymentLinkPublic,
  markPaymentLinkPaid,
  listPaymentLinks,
  ensureFreshPayLink,
  resolvePublicBaseUrl,
  normalizeBaseUrl,
  detectLanBaseUrl,
  detectLanIpv4,
  applyLanPayBaseUrl,
  bulkChangePppoeUserPlans,
  getBillingPlan,
  mikrotikProfileForPlan,
  bulkChangePppoeMikrotikProfiles,
} from './billing.js';
import {
  startUsageScheduler,
  getFairUseSettings,
  updateFairUseSettings,
  listUsageAlerts,
  ackUsageAlert,
  getUsageSummary,
  getUserUsageHistory,
  getUsageLast24hByUser,
  getSubscriberUsageDetail,
  pollUsageAndFairUse,
} from './usage.js';
import { getInterfaceNames, getTrafficSnapshot } from './interfaces.js';
import { settingsRouter } from './settings.js';
import { aiRouter } from './ai.js';
import { terminalRouter, initTerminalWs } from './terminal.js';
import { extraRouter, initExtra } from './extra.js';
import {
  getPublicSettings as getNotifySettings,
  updateSettings as updateNotifySettings,
  sendManual,
  runAutomations,
  previewBillingEnforcement,
  executeBillingEnforcement,
  listNotifications,
  startNotifyScheduler,
  getSettings as getNotifySettingsRaw,
  isExpiredAccount,
  isNonPaymentAccount,
  isBillingActiveAccount,
  sendPaymentReceiptEmail,
} from './notify.js';

initSchema();
migrate();
seed();
initExtra();

/**
 * Extend an ISO date (YYYY-MM-DD) by a whole number of months, anchored on the
 * ORIGINAL date and preserving its day-of-month. The payment day is never used
 * as the anchor, so a subscriber's billing day does not drift. If the target
 * month has fewer days, the day is clamped to that month's last day.
 */
function addMonthsPreserveDay(iso: string, months: number): string {
  const base = new Date(`${iso}T00:00:00Z`);
  const day = base.getUTCDate();
  const target = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + months, 1));
  const daysInTarget = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, daysInTarget));
  return target.toISOString().slice(0, 10);
}

const app = express();
app.use(cors());
// Company logo + GCash/Maya QR images are stored as data-URLs in JSON
// DB restore uploads arrive as base64 data-URLs (~33% larger than the .db file).
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

const PORT = Number(process.env.PORT) || 4000;

// ---- Auth ----
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
    | { id: number; username: string; password_hash: string; role: string }
    | undefined;
  if (!row || !bcrypt.compareSync(password || '', row.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const token = signToken({ id: row.id, username: row.username, role: row.role });
  const session = sessionPayload(row);
  res.json({ token, ...session });
});

app.get('/api/me', requireAuth, (req: AuthedRequest, res) => {
  if (!req.user) return res.status(401).json({ error: 'missing user' });
  const row = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(req.user.id) as
    | { id: number; username: string; role: string }
    | undefined;
  if (!row) return res.status(401).json({ error: 'user not found' });
  res.json(sessionPayload(row));
});

// Public: panel hardware ID for license / password-reset activator tools
app.get('/api/auth/panel-id', (_req, res) => {
  res.json({
    panelId: panelHardwareId(),
    defaultUser: process.env.ADMIN_USER || 'admin',
  });
});

// Public: company branding for sidebar / login (name + logo only)
app.get('/api/company/branding', (_req, res) => {
  const c = db.prepare('SELECT name, logo, address FROM company WHERE id = 1').get() as
    | { name?: string; logo?: string | null; address?: string | null }
    | undefined;
  res.json({
    name: c?.name || 'Mikrotik ISP Billing, Monitoring and Commisioning Software',
    logo: c?.logo || null,
    address: c?.address || null,
  });
});

// Public: reset panel login to default credentials using vendor activation code
app.post('/api/auth/forgot-password-reset', (req, res) => {
  const hwid = panelHardwareId();
  const provided = normalizeCode(req.body?.code);
  const expected = normalizeCode(expectedPasswordResetCode(hwid));
  if (!provided) return res.status(400).json({ error: 'Reset code is required.' });
  if (provided !== expected) {
    db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
      'warning',
      'auth',
      'Invalid password reset code attempt'
    );
    return res.status(400).json({ error: 'Invalid reset code for this panel ID.' });
  }

  const defaultUser = process.env.ADMIN_USER || 'admin';
  const defaultPass = process.env.ADMIN_PASS || 'admin123';
  const hash = bcrypt.hashSync(defaultPass, 10);

  let admin = db.prepare("SELECT * FROM users WHERE role IN ('Administrator','superadmin') ORDER BY id LIMIT 1").get() as any;
  if (!admin) admin = db.prepare('SELECT * FROM users ORDER BY id LIMIT 1').get() as any;

  if (admin) {
    const conflict = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(defaultUser, admin.id);
    if (conflict) {
      return res.status(409).json({
        error: `Cannot reset username to "${defaultUser}" — that username is already in use.`,
      });
    }
    db.prepare('UPDATE users SET username = ?, password_hash = ?, role = ? WHERE id = ?').run(
      defaultUser,
      hash,
      'Administrator',
      admin.id
    );
  } else {
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(
      defaultUser,
      hash,
      'Administrator'
    );
  }

  db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
    'warning',
    'auth',
    `Panel credentials reset to default user "${defaultUser}" via activation code`
  );

  res.json({
    ok: true,
    username: defaultUser,
    message: `Panel login reset. Sign in with ${defaultUser} / (your default password).`,
  });
});

// ---- Public subscriber payment portal (no JWT) ----
app.get('/api/public/pay/:token', (req, res) => {
  const data = getPaymentLinkPublic(String(req.params.token));
  if (!data) return res.status(404).json({ error: 'Payment link not found' });
  res.json(data);
});

/** Subscriber submits payment proof (channel + reference + optional screenshot). Awaits admin review. */
app.post('/api/public/pay/:token/submit', (req, res) => {
  try {
    const result = submitPaymentProof(String(req.params.token), {
      channel: String(req.body?.channel || ''),
      reference: String(req.body?.reference || req.body?.external_ref || ''),
      proofImage: req.body?.screenshot || req.body?.proofImage || null,
    });
    res.json(result);
  } catch (e: any) {
    res.status(400).json({ error: e?.message || 'Could not submit payment proof' });
  }
});

/** Legacy confirm endpoint — kept for compatibility; prefers reviewed/admin flow. */
app.post('/api/public/pay/:token/confirm', async (req, res) => {
  try {
    const ref = String(req.body?.reference || req.body?.external_ref || '').trim();
    if (!ref) {
      return res.status(400).json({
        error: 'Transaction / reference number is required. Use Submit payment proof on the pay page.',
      });
    }
    const channel = String(req.body?.channel || '').trim();
    if (channel) {
      const result = submitPaymentProof(String(req.params.token), {
        channel,
        reference: ref,
        proofImage: req.body?.screenshot || req.body?.proofImage || null,
      });
      return res.json(result);
    }
    // Without channel, do not auto-restore — force the new proof flow
    return res.status(400).json({
      error: 'Select GCash or Maya and submit your reference number for review.',
    });
  } catch (e: any) {
    res.status(400).json({ error: e?.message || 'Payment failed' });
  }
});

/** Public liveness probe — Updater UI polls this without an Authorization header. */
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.use('/api', requireAuth);
app.use('/api', requireLicenseOrAllowlist);
app.use('/api', requireRoleWritable);

// ---- Routers ----
app.get('/api/routers', async (_req, res) => {
  const rows = db.prepare('SELECT id, name, host, port, ssh_port, board, type, status, api_user, api_pass FROM routers').all() as any[];
  const out = await Promise.all(
    rows.map(async (r) => {
      const probe = await probeRouter({
        host: r.host,
        port: r.port,
        api_user: r.api_user,
        api_pass: r.api_pass,
      });
      const status = probe.online ? 'online' : 'offline';
      const board = probe.board || r.board;
      if (status !== r.status || (probe.board && probe.board !== r.board)) {
        db.prepare('UPDATE routers SET status = ?, board = ? WHERE id = ?').run(status, board, r.id);
      }
      const { api_user: _u, api_pass: _p, ...pub } = r;
      return { ...pub, status, board };
    })
  );
  res.json(out);
});

function getRouter(id: number) {
  return db.prepare('SELECT * FROM routers WHERE id = ?').get(id) as any;
}

function parseRouterId(raw: unknown): number | null {
  const n = raw != null && raw !== '' ? Number(raw) : null;
  return n != null && Number.isFinite(n) && n > 0 ? n : null;
}

function routerConnForId(routerId: number | null) {
  if (!routerId) return null;
  const r = getRouter(routerId);
  if (!r?.host || !r?.api_user) return null;
  return {
    host: r.host,
    port: Number(r.port) || 8728,
    api_user: r.api_user,
    api_pass: r.api_pass,
  };
}

// ---- Dashboard ----
app.get('/api/dashboard/host', async (_req, res) => {
  try {
    const [cpu, mem, temp, time, fs, system, osInfo] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.cpuTemperature(),
      si.time(),
      si.fsSize(),
      si.system(),
      si.osInfo(),
    ]);
    const disk = fs[0] || ({ size: 1, used: 0 } as any);
    const hostname = osInfo.hostname || os.hostname();
    const board = [system.manufacturer, system.model].filter(Boolean).join(' ').trim() || hostname;
    res.json({
      hostname,
      board,
      cpuTemp: temp.main && temp.main > 0 ? Number(temp.main.toFixed(1)) : null,
      cpuUsage: Number(cpu.currentLoad.toFixed(1)),
      ramTotal: mem.total,
      ramUsed: mem.active,
      ramPct: Number(((mem.active / mem.total) * 100).toFixed(1)),
      diskPct: Number(((disk.used / disk.size) * 100).toFixed(1)),
      diskUsed: disk.used,
      diskTotal: disk.size,
      uptime: time.uptime,
    });
  } catch {
    res.json({
      hostname: os.hostname(),
      board: 'Panel server',
      cpuTemp: null,
      cpuUsage: 0,
      ramPct: 0,
      diskPct: 0,
      uptime: 0,
    });
  }
});

app.get('/api/dashboard/router/:id', async (req, res) => {
  const r = getRouter(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'router not found' });

  type Row = {
    username: string;
    status: string;
    panelStatus: string;
    online: number;
    subscriptionDue: string | null;
    nonpaymentSince: string | null;
    expirationProfile: string | null;
    mikrotikProfile: string | null;
  };

  let users = db
    .prepare(
      `SELECT username, status, status AS panelStatus, online,
              subscription_due AS subscriptionDue,
              nonpayment_since AS nonpaymentSince,
              expiration_profile AS expirationProfile,
              NULL AS mikrotikProfile
       FROM pppoe_users WHERE router_id = ?`
    )
    .all(r.id) as Row[];

  let liveSessions = false;
  if (r.host && r.api_user) {
    try {
      const [secrets, sessions] = await Promise.all([fetchPppSecrets(r), fetchPppActive(r)]);
      const enriched = enrichPppUsersFromLive(users, secrets, sessions);
      const markNp = db.prepare(
        `UPDATE pppoe_users
         SET status = 'non-payment',
             nonpayment_since = COALESCE(nonpayment_since, ?)
         WHERE router_id = ? AND username = ? AND lower(status) = 'active'`
      );
      const nowIso = new Date().toISOString();
      for (let i = 0; i < users.length; i++) {
        const e = enriched[i];
        let panel = String(e.panelStatus || users[i].status || '');
        const mtProfile = e.mikrotikProfile || null;
        users[i].mikrotikProfile = mtProfile;
        const onNpProfile =
          !!mtProfile &&
          (/non[-_\s]?pay/i.test(mtProfile) ||
            (!!users[i].expirationProfile &&
              /non[-_\s]?pay/i.test(String(users[i].expirationProfile)) &&
              mtProfile.toLowerCase() === String(users[i].expirationProfile).toLowerCase()));
        if (
          onNpProfile &&
          String(panel).toLowerCase() === 'active' &&
          String(e.status).toLowerCase() !== 'disabled'
        ) {
          panel = 'non-payment';
          markNp.run(nowIso, r.id, users[i].username);
          users[i].nonpaymentSince = users[i].nonpaymentSince || nowIso;
        }
        users[i].panelStatus = panel;
        users[i].status = e.status;
        users[i].online = e.online;
      }

      const updOnline = db.prepare('UPDATE pppoe_users SET online = ? WHERE router_id = ? AND username = ?');
      const updStatus = db.prepare(
        "UPDATE pppoe_users SET status = 'Active' WHERE router_id = ? AND username = ? AND lower(status) = 'disabled'"
      );
      const tx = db.transaction(() => {
        for (const u of enriched) {
          updOnline.run(u.online ? 1 : 0, r.id, u.username);
          const panel = String(u.panelStatus || '').toLowerCase().replace(/\s+/g, '-');
          const billingHold =
            isNonPaymentAccount({
              status: u.panelStatus,
              panelStatus: u.panelStatus,
              nonpaymentSince: u.nonpaymentSince,
              mikrotikProfile: u.mikrotikProfile,
              expirationProfile: (u as any).expirationProfile,
            }) ||
            isExpiredAccount({
              status: u.panelStatus,
              panelStatus: u.panelStatus,
              subscriptionDue: (u as any).subscriptionDue,
              nonpaymentSince: u.nonpaymentSince,
            });
          if (String(u.status).toLowerCase() === 'active' && panel === 'disabled' && !billingHold) {
            updStatus.run(r.id, u.username);
          }
        }
      });
      tx();
      liveSessions = true;
    } catch {
      /* keep DB rows */
    }
  }

  const classify = (u: Row) => ({
    status: u.panelStatus || u.status,
    panelStatus: u.panelStatus || u.status,
    nonpaymentSince: u.nonpaymentSince,
    mikrotikProfile: u.mikrotikProfile,
    expirationProfile: u.expirationProfile,
    subscriptionDue: u.subscriptionDue,
  });
  const activeUsers = users.filter((u) => isBillingActiveAccount(classify(u)));
  const online = activeUsers.filter((u) => !!u.online).length;
  const offline = activeUsers.filter((u) => !u.online).length;
  const expired = users.filter((u) => isExpiredAccount(classify(u))).length;

  const liveStats = await fetchRouterDashboardStats(r);

  res.json({
    name: r.name,
    host: r.host,
    board: liveStats.board || r.board,
    live: liveStats.live,
    liveSessions,
    uptime: liveStats.uptime || '—',
    cpuLoad: liveStats.cpuLoad,
    memPct: liveStats.memPct,
    memTotal: liveStats.memTotalMb,
    // Same definition as Account Status → Active (billing-active), not live session count
    activePPPoE: activeUsers.length,
    online,
    offline,
    expired,
  });
});

app.get('/api/dashboard/queues', async (req, res) => {
  const routerId = req.query.routerId ? Number(req.query.routerId) : null;
  if (routerId) {
    const router = getRouter(routerId);
    if (router?.host && router?.api_user) {
      try {
        const queues = await fetchRouterQueues(router);
        return res.json({ live: true, queues });
      } catch (e: any) {
        return res.json({
          live: false,
          error: e?.message || 'Could not read queue tree from MikroTik',
          queues: db.prepare('SELECT name, avg_rate AS avgRate FROM queues ORDER BY avg_rate DESC').all(),
        });
      }
    }
  }
  res.json({
    live: false,
    queues: db.prepare('SELECT name, avg_rate AS avgRate FROM queues ORDER BY avg_rate DESC').all(),
  });
});

// Account status breakdown for the dashboard tiles (live MikroTik when router selected).
app.get('/api/dashboard/status', async (req, res) => {
  const routerId = req.query.routerId ? Number(req.query.routerId) : null;
  const where = routerId ? 'WHERE router_id = ?' : '';
  type StatusRow = {
    username: string;
    status: string;
    panelStatus: string;
    online: number;
    routerId: number;
    subscriptionDue: string | null;
    nonpaymentSince: string | null;
    expirationProfile: string | null;
    mikrotikProfile: string | null;
  };
  let rows = (routerId
    ? db
        .prepare(
          `SELECT username, status, status AS panelStatus, online, router_id AS routerId,
                  subscription_due AS subscriptionDue, nonpayment_since AS nonpaymentSince,
                  expiration_profile AS expirationProfile, NULL AS mikrotikProfile
           FROM pppoe_users ${where}`
        )
        .all(routerId)
    : db
        .prepare(
          `SELECT username, status, status AS panelStatus, online, router_id AS routerId,
                  subscription_due AS subscriptionDue, nonpayment_since AS nonpaymentSince,
                  expiration_profile AS expirationProfile, NULL AS mikrotikProfile
           FROM pppoe_users`
        )
        .all()) as StatusRow[];

  let live = false;
  const enrichRouter = async (rid: number, subset: StatusRow[]) => {
    const router = getRouter(rid);
    if (!router?.host || !router?.api_user || !subset.length) return;
    try {
      const [secrets, sessions] = await Promise.all([fetchPppSecrets(router), fetchPppActive(router)]);
      const enriched = enrichPppUsersFromLive(subset, secrets, sessions);
      const markNp = db.prepare(
        `UPDATE pppoe_users
         SET status = 'non-payment',
             nonpayment_since = COALESCE(nonpayment_since, ?)
         WHERE router_id = ? AND username = ? AND lower(status) = 'active'`
      );
      const nowIso = new Date().toISOString();
      for (let i = 0; i < subset.length; i++) {
        const e = enriched[i];
        let panel = String(e.panelStatus || subset[i].status || '');
        const mtProfile = e.mikrotikProfile || null;
        subset[i].mikrotikProfile = mtProfile;
        const onNpProfile =
          !!mtProfile &&
          (/non[-_\s]?pay/i.test(mtProfile) ||
            (!!subset[i].expirationProfile &&
              /non[-_\s]?pay/i.test(String(subset[i].expirationProfile)) &&
              mtProfile.toLowerCase() === String(subset[i].expirationProfile).toLowerCase()));
        if (
          onNpProfile &&
          String(panel).toLowerCase() === 'active' &&
          String(e.status).toLowerCase() !== 'disabled'
        ) {
          panel = 'non-payment';
          markNp.run(nowIso, rid, subset[i].username);
          subset[i].nonpaymentSince = subset[i].nonpaymentSince || nowIso;
        }
        subset[i].panelStatus = panel;
        subset[i].status = e.status;
        subset[i].online = e.online;
      }
      const updOnline = db.prepare('UPDATE pppoe_users SET online = ? WHERE router_id = ? AND username = ?');
      const updStatus = db.prepare(
        "UPDATE pppoe_users SET status = 'Active' WHERE router_id = ? AND username = ? AND lower(status) = 'disabled'"
      );
      const tx = db.transaction(() => {
        for (const u of enriched) {
          updOnline.run(u.online ? 1 : 0, rid, u.username);
          const panel = String(u.panelStatus || '').toLowerCase().replace(/\s+/g, '-');
          const billingHold =
            isNonPaymentAccount({
              status: u.panelStatus,
              panelStatus: u.panelStatus,
              nonpaymentSince: u.nonpaymentSince,
              mikrotikProfile: u.mikrotikProfile,
              expirationProfile: (u as any).expirationProfile,
            }) ||
            isExpiredAccount({
              status: u.panelStatus,
              panelStatus: u.panelStatus,
              subscriptionDue: (u as any).subscriptionDue,
              nonpaymentSince: u.nonpaymentSince,
            });
          if (String(u.status).toLowerCase() === 'active' && panel === 'disabled' && !billingHold) {
            updStatus.run(rid, u.username);
          }
        }
      });
      tx();
      live = true;
    } catch {
      /* keep DB */
    }
  };

  if (routerId) {
    await enrichRouter(routerId, rows);
  } else {
    const byRouter = new Map<number, StatusRow[]>();
    for (const u of rows) {
      const rid = u.routerId || 0;
      if (!rid) continue;
      if (!byRouter.has(rid)) byRouter.set(rid, []);
      byRouter.get(rid)!.push(u);
    }
    await Promise.all([...byRouter.entries()].map(([rid, subset]) => enrichRouter(rid, subset)));
  }

  const panelOf = (r: StatusRow) => String(r.panelStatus || r.status || '').toLowerCase().replace(/\s+/g, '-');
  const liveOf = (r: StatusRow) => String(r.status || '').toLowerCase();
  const classify = (r: StatusRow) => ({
    status: r.panelStatus || r.status,
    panelStatus: r.panelStatus || r.status,
    nonpaymentSince: r.nonpaymentSince,
    mikrotikProfile: r.mikrotikProfile,
    expirationProfile: r.expirationProfile,
    subscriptionDue: r.subscriptionDue,
  });
  const active = rows.filter((r) => isBillingActiveAccount(classify(r)));
  res.json({
    total: rows.length,
    online: active.filter((r) => !!r.online).length,
    offline: active.filter((r) => !r.online).length,
    active: active.length,
    expired: rows.filter((r) => isExpiredAccount(classify(r))).length,
    nonPayment: rows.filter((r) => isNonPaymentAccount(classify(r))).length,
    inactive: rows.filter((r) => panelOf(r) === 'inactive').length,
    disabled: rows.filter((r) => liveOf(r) === 'disabled' || panelOf(r) === 'disabled').length,
    live,
  });
});

// ---- Sales ----
function yearMonthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function yearMonthFromIso(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso.slice(0, 7);
  return yearMonthKey(d);
}

function isoWeek(d: Date): string {
  // ISO-8601 week number, returned as "YYYY-Www".
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((dt.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

app.get('/api/sales', (req, res) => {
  const now = new Date();
  // Support both legacy ranges (7d/30d/6m/1y) and group buckets (week/month/year).
  const group = req.query.group ? String(req.query.group) : null;

  if (group === 'week' || group === 'month' || group === 'year') {
    const rows = db.prepare('SELECT amount, created_at FROM transactions ORDER BY created_at').all() as { amount: number; created_at: string }[];
    const buckets = new Map<string, number>();
    const keyOf = (iso: string) => {
      const d = new Date(iso);
      if (group === 'week') return isoWeek(d);
      if (group === 'month') return yearMonthFromIso(iso);
      return iso.slice(0, 4);
    };
    for (const r of rows) buckets.set(keyOf(r.created_at), (buckets.get(keyOf(r.created_at)) || 0) + r.amount);
    const series: { label: string; value: number }[] = [];
    if (group === 'week') {
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getTime() - i * 7 * 86400000);
        const key = isoWeek(d);
        series.push({ label: key, value: buckets.get(key) || 0 });
      }
    } else if (group === 'month') {
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const key = yearMonthKey(d);
        series.push({ label: key, value: buckets.get(key) || 0 });
      }
    } else {
      for (let i = 4; i >= 0; i--) {
        const key = String(now.getFullYear() - i);
        series.push({ label: key, value: buckets.get(key) || 0 });
      }
    }
    const windowTotal = series.reduce((s, x) => s + x.value, 0);
    const nonZero = series.filter((x) => x.value > 0).length;
    res.json({
      series,
      total: windowTotal,
      transactions: rows.length,
      avgPerDay: nonZero ? windowTotal / nonZero : 0,
      best: Math.max(0, ...series.map((s) => s.value)),
      today: 0,
      group,
    });
    return;
  }

  const range = String(req.query.range || '7d');
  let days = 7;
  if (range === '30d') days = 30;
  else if (range === '6m') days = 182;
  else if (range === '1y') days = 365;
  const since = new Date(now.getTime() - days * 86400000).toISOString();
  const rows = db
    .prepare('SELECT amount, created_at FROM transactions WHERE created_at >= ? ORDER BY created_at')
    .all(since) as { amount: number; created_at: string }[];

  const buckets = new Map<string, number>();
  const bucketBy = days <= 30 ? 'day' : 'month';
  for (const r of rows) {
    const d = new Date(r.created_at);
    const key = bucketBy === 'day' ? d.toISOString().slice(0, 10) : yearMonthKey(d);
    buckets.set(key, (buckets.get(key) || 0) + r.amount);
  }
  const series: { label: string; value: number }[] = [];
  if (bucketBy === 'day') {
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000);
      const key = d.toISOString().slice(0, 10);
      series.push({ label: key, value: buckets.get(key) || 0 });
    }
  } else {
    const months = range === '1y' ? 12 : 6;
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = yearMonthKey(d);
      series.push({ label: key, value: buckets.get(key) || 0 });
    }
  }
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const transactions = rows.length;
  const daysWithRevenue = new Set(rows.map((r) => r.created_at.slice(0, 10)));
  const avgPerDay = daysWithRevenue.size ? total / daysWithRevenue.size : 0;
  const best = Math.max(0, ...series.map((s) => s.value));
  const todayKey = now.toISOString().slice(0, 10);
  const today = rows.filter((r) => r.created_at.slice(0, 10) === todayKey).reduce((s, r) => s + r.amount, 0);
  res.json({ series, total, transactions, avgPerDay, best, today });
});

app.get('/api/sales/transactions', (_req, res) => {
  res.json(
    db.prepare('SELECT id, customer_name AS customer, amount, type, created_at AS date FROM transactions ORDER BY created_at DESC LIMIT 200').all()
  );
});

app.get('/api/sales/transactions/:id/receipt', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid transaction id' });
  }
  const receipt = getTransactionReceipt(id);
  if (!receipt) return res.status(404).json({ error: 'Transaction not found' });
  res.json({ receipt });
});

app.delete('/api/sales/transactions', (req, res) => {
  const month = req.query.month ? String(req.query.month) : null;
  if (month) {
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'month must be YYYY-MM' });
    }
    const info = db
      .prepare("DELETE FROM transactions WHERE strftime('%Y-%m', created_at) = ?")
      .run(month);
    db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
      'warning',
      'sales',
      `Cleared ${info.changes} transaction(s) for ${month}`
    );
    return res.json({ ok: true, deleted: info.changes, month });
  }
  const info = db.prepare('DELETE FROM transactions').run();
  db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
    'warning',
    'sales',
    `Cleared all ${info.changes} transaction(s)`
  );
  res.json({ ok: true, deleted: info.changes });
});

// ---- PPPoE ----
function getRouterById(routerId: number | null | undefined) {
  if (!routerId) return null;
  return db.prepare('SELECT * FROM routers WHERE id = ?').get(routerId) as any;
}

/** Billing JSON for /ppp/secret comment — same shape as fetch-from-MikroTik import. */
function commentFromPppoeUser(u: {
  profile?: string | null;
  subscription_due?: string | null;
  expiration_profile?: string | null;
  account_number?: string | number | null;
  customer_name?: string | null;
  address?: string | null;
  contact?: string | null;
  email?: string | null;
  nap_id?: string | number | null;
  status?: string | null;
  plc_port?: string | number | null;
  lat?: number | null;
  lng?: number | null;
}) {
  return buildPppSecretComment({
    plan: u.profile,
    dueDate: u.subscription_due,
    expireProfile: u.expiration_profile || 'non-payments',
    accountNumber: u.account_number,
    customer: {
      fullName: u.customer_name,
      address: u.address,
      contactNumber: u.contact,
      email: u.email,
      napId: u.nap_id,
      status: u.status,
      plcPort: u.plc_port,
      latitude: u.lat,
      longitude: u.lng,
    },
  });
}

function routerHasApi(router: any): boolean {
  return !!(router?.host && router?.api_user);
}

function secretDisabledFromStatus(status: unknown): boolean {
  const s = String(status || '').toLowerCase();
  // Non-payment keeps the secret enabled (expire profile only). Disable past grace.
  return s === 'disabled' || s === 'expired';
}

app.get('/api/pppoe/users', async (req, res) => {
  const service = String(req.query.service || 'pppoe');
  const routerId = req.query.routerId ? Number(req.query.routerId) : null;
  // Live traffic is for Active Connections; Users tab uses 24h usage instead.
  // traffic=1 still supported for callers that need live rates on the user list.
  const wantTraffic = String(req.query.traffic ?? '0') === '1';
  let rows = (
    routerId
      ? db
          .prepare(
            `SELECT id, username, customer_name AS customer, account_number AS account, profile, status,
                    status AS panelStatus,
                    subscription_due AS subscriptionDue, price, address, lat, lng, email, contact, online,
                    router_id AS routerId, nonpayment_since AS nonpaymentSince,
                    expiration_profile AS expirationProfile
             FROM pppoe_users WHERE service = ? AND router_id = ? ORDER BY id`
          )
          .all(service, routerId)
      : db
          .prepare(
            `SELECT id, username, customer_name AS customer, account_number AS account, profile, status,
                    status AS panelStatus,
                    subscription_due AS subscriptionDue, price, address, lat, lng, email, contact, online,
                    router_id AS routerId, nonpayment_since AS nonpaymentSince,
                    expiration_profile AS expirationProfile
             FROM pppoe_users WHERE service = ? ORDER BY id`
          )
          .all(service)
  ) as any[];

  // Enrich with live MikroTik secret profile + session online when a router is selected.
  const router = getRouterById(routerId);
  let live = false;
  if (router?.host && router?.api_user) {
    try {
      // One TCP session for secrets + active (avoids double connect on 1–Ns polls).
      const { secrets, sessions } = await fetchPppSecretsAndActive(router);
      rows = enrichPppUsersFromLive(rows, secrets, sessions).map((u) => ({ ...u, live: true }));
      live = true;
      if (wantTraffic) {
        const onlineNames = rows.filter((u) => u.sessionOnline).map((u) => String(u.username));
        if (onlineNames.length) {
          try {
            const addresses: Record<string, string> = {};
            for (const s of sessions) {
              if (s.name && s.address && s.address !== '-') addresses[s.name] = s.address;
            }
            const traffic = await fetchPppActiveTraffic(router, onlineNames, { addresses });
            const byKey = new Map<string, { download: number; upload: number }>();
            for (const [name, t] of Object.entries(traffic)) byKey.set(pppNameKey(name), t);
            rows = rows.map((u) => {
              const t = byKey.get(pppNameKey(u.username));
              return {
                ...u,
                downloadBps: t?.download ?? 0,
                uploadBps: t?.upload ?? 0,
              };
            });
          } catch {
            /* traffic optional */
          }
        }
      }
    } catch {
      /* keep DB rows */
    }
  }

  const usage24h = getUsageLast24hByUser({
    routerId,
    usernames: rows.map((u) => String(u.username)),
  });

  res.json(
    rows.map((u) => {
      const usage = usage24h.get(pppNameKey(u.username));
      return {
        ...u,
        live,
        panelStatus: u.panelStatus ?? u.status,
        nonpaymentSince: u.nonpaymentSince ?? null,
        expirationProfile: u.expirationProfile ?? null,
        downloadBps: u.downloadBps ?? 0,
        uploadBps: u.uploadBps ?? 0,
        usage24hRx: usage?.rxBytes ?? 0,
        usage24hTx: usage?.txBytes ?? 0,
      };
    })
  );
});

// Full record for the edit form.
app.get('/api/pppoe/users/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

// Generate a unique 12-digit numeric account number.
function generateAccountNumber(): string {
  const exists = db.prepare('SELECT 1 FROM pppoe_users WHERE account_number = ?');
  for (let i = 0; i < 25; i++) {
    const n = String(Math.floor(100000000000 + Math.random() * 900000000000));
    if (!exists.get(n)) return n;
  }
  return String(Date.now()).slice(-12).padStart(12, '0');
}

app.post('/api/pppoe/users', async (req, res) => {
  const b = req.body || {};
  const {
    username, password, customer_name, profile, status, subscription_due, price, service,
    expiration_profile, contact, email, nap_id, plc_port, address, lat, lng,
  } = b;
  if (!username) return res.status(400).json({ error: 'username is required' });
  if (!password) return res.status(400).json({ error: 'password is required to create the MikroTik PPP secret' });
  if (!profile || isSystemPppProfileName(profile)) {
    return res.status(400).json({ error: 'Select a billing plan (not default / non-payments)' });
  }

  const routerId = Number(b.router_id || b.routerId || 0);
  if (!routerId) {
    return res.status(400).json({ error: 'Select a router first (routerId required to create PPP secret).' });
  }
  const router = getRouterById(routerId);
  if (!router) return res.status(404).json({ error: 'Router not found' });

  const prof = db.prepare('SELECT price FROM profiles WHERE name = ?').get(profile) as { price: number } | undefined;
  const account = generateAccountNumber();
  let insertedId: number | null = null;
  try {
    const info = db
      .prepare(
        `INSERT INTO pppoe_users
          (username, password, customer_name, account_number, profile, status, subscription_due, price,
           router_id, service, expiration_profile, contact, email, nap_id, plc_port, address, lat, lng, online)
         VALUES (@username, @password, @customer_name, @account, @profile, @status, @subscription_due, @price,
           @router_id, @service, @expiration_profile, @contact, @email, @nap_id, @plc_port, @address, @lat, @lng, 1)`
      )
      .run({
        username,
        password: password || '',
        customer_name: customer_name || username,
        account,
        profile: profile || '15mbps',
        status: status || 'Active',
        subscription_due: subscription_due || new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
        price: price ?? prof?.price ?? 0,
        router_id: routerId,
        service: service || 'pppoe',
        expiration_profile: expiration_profile || 'non-payments',
        contact: contact || null,
        email: email || null,
        nap_id: nap_id || null,
        plc_port: plc_port || null,
        address: address || null,
        lat: lat != null && lat !== '' ? Number(lat) : null,
        lng: lng != null && lng !== '' ? Number(lng) : null,
      });
    insertedId = Number(info.lastInsertRowid);
  } catch (e: any) {
    if (String(e?.message || '').includes('UNIQUE')) {
      return res.status(409).json({ error: 'Username already exists' });
    }
    throw e;
  }

  const row = db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(insertedId) as any;

  if (!routerHasApi(router)) {
    db.prepare('DELETE FROM pppoe_users WHERE id = ?').run(insertedId);
    return res.status(400).json({
      error:
        'Router API credentials are not configured. Open Router Management, set Host + API user/password, then try again.',
    });
  }

  try {
    const planMeta = getBillingPlan(row.profile);
    const mtProfile = planMeta?.pppProfile || mikrotikProfileForPlan(row.profile);
    if (!mtProfile) {
      db.prepare('DELETE FROM pppoe_users WHERE id = ?').run(insertedId);
      return res.status(400).json({
        error: `Billing plan "${row.profile}" has no linked MikroTik PPP profile. Edit the plan under Billing Plans and select an existing profile.`,
      });
    }
    await addPppSecret(router, {
      name: row.username,
      password: row.password || '',
      profile: mtProfile,
      service: row.service === 'ipoe' ? 'pppoe' : row.service || 'pppoe',
      comment: commentFromPppoeUser(row),
      disabled: secretDisabledFromStatus(row.status),
    });
  } catch (e: any) {
    db.prepare('DELETE FROM pppoe_users WHERE id = ?').run(insertedId);
    return res.status(502).json({
      error: e?.message || 'Failed to create PPP secret on MikroTik',
    });
  }

  db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
    'info',
    'pppoe',
    `Created ${row.service || 'pppoe'} user ${username} (acct ${account}) + MikroTik secret`
  );
  res.status(201).json(row);
});

app.put('/api/pppoe/users/:id', async (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(id) as any;
  if (!existing) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};

  // If the billing plan changed, sync the stored price to the plan's price
  // (unless an explicit price override is supplied).
  const newProfile = b.profile ?? existing.profile;
  if (b.profile != null && isSystemPppProfileName(newProfile)) {
    return res.status(400).json({ error: 'Select a billing plan (not default / non-payments)' });
  }
  let price = b.price ?? existing.price;
  if (b.profile && b.profile !== existing.profile && b.price == null) {
    const prof = db.prepare('SELECT price FROM profiles WHERE name = ?').get(newProfile) as { price: number } | undefined;
    if (prof) price = prof.price;
  }

  db.prepare(
    `UPDATE pppoe_users SET
       customer_name = @customer_name, password = @password, profile = @profile, status = @status,
       subscription_due = @subscription_due, price = @price, expiration_profile = @expiration_profile,
       contact = @contact, email = @email, nap_id = @nap_id, plc_port = @plc_port,
       address = @address, lat = @lat, lng = @lng
     WHERE id = @id`
  ).run({
    id,
    customer_name: b.customer_name ?? existing.customer_name,
    password: b.password ?? existing.password,
    profile: newProfile,
    status: b.status ?? existing.status,
    subscription_due: b.subscription_due ?? existing.subscription_due,
    price,
    expiration_profile: b.expiration_profile ?? existing.expiration_profile,
    contact: b.contact ?? existing.contact,
    email: b.email ?? existing.email,
    nap_id: b.nap_id != null ? (b.nap_id || null) : existing.nap_id,
    plc_port: b.plc_port ?? existing.plc_port,
    address: b.address ?? existing.address,
    lat: b.lat != null && b.lat !== '' ? Number(b.lat) : b.lat === '' ? null : existing.lat,
    lng: b.lng != null && b.lng !== '' ? Number(b.lng) : b.lng === '' ? null : existing.lng,
  });

  const row = db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(id) as any;
  const router = getRouterById(row.router_id);
  if (routerHasApi(router)) {
    try {
      const planMeta = getBillingPlan(row.profile);
      const mtProfile = planMeta?.pppProfile || mikrotikProfileForPlan(row.profile);
      const st = String(row.status || '').toLowerCase();
      const expireProf =
        row.expiration_profile && row.expiration_profile !== 'default'
          ? row.expiration_profile
          : 'non-payments';
      if (st !== 'non-payment' && st !== 'nonpayment' && st !== 'disabled' && !mtProfile) {
        return res.status(400).json({
          error: `Billing plan "${row.profile}" has no linked MikroTik PPP profile. Edit the plan under Billing Plans and select an existing profile.`,
          user: row,
        });
      }
      const secretProfile =
        st === 'non-payment' || st === 'nonpayment'
          ? expireProf
          : st === 'disabled'
            ? undefined
            : mtProfile;
      await updatePppSecret(router, existing.username, {
        password: row.password || '',
        profile: secretProfile,
        service: row.service === 'ipoe' ? 'pppoe' : row.service || undefined,
        comment: commentFromPppoeUser(row),
        disabled: secretDisabledFromStatus(row.status),
      });
    } catch (e: any) {
      return res.status(502).json({
        error: e?.message || 'Failed to update PPP secret on MikroTik',
        user: row,
      });
    }
  }

  res.json(row);
});

// Enable/disable the client account on MikroTik (/ppp/secret) and in the DB.
app.post('/api/pppoe/users/:id/toggle-enabled', async (req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(id) as any;
  if (!u) return res.status(404).json({ error: 'not found' });
  const disabling = u.status !== 'disabled';
  const router = getRouterById(u.router_id);
  if (router?.host && router?.api_user) {
    try {
      await setPppSecretEnabled(router, u.username, !disabling);
      if (disabling) {
        try {
          await removePppActiveByName(router, u.username);
        } catch {
          /* session drop is best-effort */
        }
      }
    } catch (e: any) {
      return res.status(502).json({ error: e?.message || 'Could not update PPP secret on MikroTik' });
    }
  }
  if (disabling) {
    db.prepare("UPDATE pppoe_users SET status = 'disabled', online = 0 WHERE id = ?").run(id);
  } else {
    db.prepare("UPDATE pppoe_users SET status = 'Active', online = 0, nonpayment_since = NULL WHERE id = ?").run(id);
  }
  db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
    'info',
    'mikrotik',
    `${disabling ? 'Disabled' : 'Enabled'} ${u.service} secret for ${u.username}`
  );
  res.json({
    ok: true,
    status: disabling ? 'disabled' : 'Active',
    action: disabling ? 'disabled' : 'enabled',
    username: u.username,
    customer: u.customer_name,
    user: db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(id),
  });
});

app.delete('/api/pppoe/users/:id', async (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(id) as any;
  if (!existing) return res.status(404).json({ error: 'not found' });

  const router = getRouterById(existing.router_id);
  if (routerHasApi(router)) {
    try {
      await removePppSecret(router, existing.username);
    } catch {
      /* still delete from panel if secret already gone */
    }
  }

  db.prepare('DELETE FROM pppoe_users WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.post('/api/pppoe/users/bulk-disable', (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
    .map((id: unknown) => Number(id))
    .filter((id: number) => Number.isFinite(id) && id > 0);
  if (!ids.length) return res.status(400).json({ error: 'No user IDs provided.' });

  const stmt = db.prepare("UPDATE pppoe_users SET status = 'disabled', online = 0 WHERE id = ?");
  let count = 0;
  for (const id of ids) {
    const u = db.prepare('SELECT username, service FROM pppoe_users WHERE id = ?').get(id) as any;
    if (!u) continue;
    stmt.run(id);
    count++;
    db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
      'info',
      'mikrotik',
      `Bulk disabled ${u.service} secret for ${u.username}`
    );
  }
  res.json({ ok: true, count });
});

app.post('/api/pppoe/users/bulk-change-plan', async (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
    .map((id: unknown) => Number(id))
    .filter((id: number) => Number.isFinite(id) && id > 0);
  const plan = String(req.body?.plan || '').trim();
  if (!ids.length) return res.status(400).json({ error: 'No user IDs provided.' });
  if (!plan) return res.status(400).json({ error: 'Select a billing plan.' });
  if (isSystemPppProfileName(plan)) {
    return res.status(400).json({ error: 'Select a billing plan (not default / non-payments).' });
  }
  const planRow = db
    .prepare(`SELECT name, ppp_profile FROM profiles WHERE name = ? AND coalesce(type, 'pppoe') = 'plan'`)
    .get(plan) as { name: string; ppp_profile?: string } | undefined;
  if (!planRow) return res.status(404).json({ error: `Billing plan "${plan}" not found.` });
  if (!String(planRow.ppp_profile || '').trim()) {
    return res.status(400).json({
      error: `Billing plan "${plan}" has no linked MikroTik PPP profile. Edit it under Billing Plans.`,
    });
  }

  try {
    const result = await bulkChangePppoeUserPlans(ids, plan);
    res.json({
      ok: result.ok,
      plan: result.plan,
      updated: result.updated,
      bounced: result.bounced,
      failed: result.failed,
      message: `Changed plan to ${result.plan} for ${result.updated} user(s); session refresh bounce on ${result.bounced}.`,
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Bulk plan change failed' });
  }
});

app.post('/api/pppoe/users/bulk-change-profile', async (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
    .map((id: unknown) => Number(id))
    .filter((id: number) => Number.isFinite(id) && id > 0);
  const profile = String(req.body?.profile || '').trim();
  if (!ids.length) return res.status(400).json({ error: 'No user IDs provided.' });
  if (!profile) return res.status(400).json({ error: 'Select a MikroTik PPP profile.' });

  try {
    const result = await bulkChangePppoeMikrotikProfiles(ids, profile);
    res.json({
      ok: result.ok,
      profile: result.profile,
      updated: result.updated,
      bounced: result.bounced,
      failed: result.failed,
      message: `Set MikroTik profile to ${result.profile} for ${result.updated} user(s); session refresh on ${result.bounced}.`,
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Bulk profile change failed' });
  }
});

app.post('/api/pppoe/users/bulk-delete', async (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
    .map((id: unknown) => Number(id))
    .filter((id: number) => Number.isFinite(id) && id > 0);
  if (!ids.length) return res.status(400).json({ error: 'No user IDs provided.' });

  const stmt = db.prepare('DELETE FROM pppoe_users WHERE id = ?');
  let count = 0;
  for (const id of ids) {
    const u = db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(id) as any;
    if (!u) continue;
    const router = getRouterById(u.router_id);
    if (routerHasApi(router)) {
      try {
        await removePppSecret(router, u.username);
      } catch {
        /* continue */
      }
    }
    const info = stmt.run(id);
    if (info.changes) count++;
  }
  db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
    'warning',
    'mikrotik',
    `Bulk deleted ${count} PPPoE/IPoE user(s)`
  );
  res.json({ ok: true, count });
});

// Execute a payment: extends the subscription by whole month(s) from the
// existing expiration date (preserving day-of-month, never re-anchored to the
// payment day) and records the transaction.
app.post('/api/pppoe/users/:id/payment', async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  try {
    const result = await recordPppoePayment(id, {
      months: b.months,
      plan: b.plan,
      expiration_profile: b.expiration_profile,
      payment_date: b.payment_date,
      discount_days: b.discount_days,
      source: 'admin',
    });
    let emailed = false;
    if (b.send_receipt && result.user?.email) {
      const receipt = result.receipt;
      const r = await sendPaymentReceiptEmail({
        to: result.user.email,
        clientId: id,
        customerName: result.user.customer_name || receipt?.customer,
        receipt,
      });
      emailed = r.sent;
    }
    res.json({ ...result, emailed });
  } catch (e: any) {
    const code = /not found/i.test(e?.message || '') ? 404 : 400;
    res.status(code).json({ error: e?.message || 'Payment failed' });
  }
});

// ---- Payment links ----
app.get('/api/payment-links', (_req, res) => {
  const resolved = resolvePublicBaseUrl();
  res.json({
    links: listPaymentLinks(200),
    publicBaseUrl: resolved.baseUrl || null,
    source: resolved.source,
    warning: resolved.warning || null,
  });
});

app.get('/api/payment-links/config', (_req, res) => {
  const app = db
    .prepare(
      `SELECT public_base_url, ngrok_url, ngrok_status,
              cf_tunnel_url, cf_tunnel_status, cf_tunnel_hostname
       FROM app_settings WHERE id = 1`
    )
    .get() as any;
  const resolved = resolvePublicBaseUrl();
  const lanBaseUrl = detectLanBaseUrl() || null;
  res.json({
    publicBaseUrl: app?.public_base_url || '',
    envPublicBaseUrl: process.env.PUBLIC_BASE_URL || null,
    ngrokUrl: app?.ngrok_status === 'running' ? app?.ngrok_url || null : null,
    cloudflareUrl:
      app?.cf_tunnel_status === 'running'
        ? app?.cf_tunnel_url || (app?.cf_tunnel_hostname ? `https://${app.cf_tunnel_hostname}` : null)
        : null,
    websiteUrl: resolved.baseUrl ? `${String(resolved.baseUrl).replace(/\/$/, '')}/login` : null,
    lanIp: detectLanIpv4(),
    lanBaseUrl,
    effective: resolved.baseUrl || null,
    source: resolved.source,
    warning: resolved.warning || null,
  });
});

app.put('/api/payment-links/config', (req, res) => {
  const raw = req.body?.publicBaseUrl ?? req.body?.public_base_url;
  const normalized = raw === '' || raw == null ? null : normalizeBaseUrl(String(raw));
  if (raw && String(raw).trim() && !normalized) {
    return res.status(400).json({ error: 'Invalid public URL. Example: https://billing.example.com' });
  }
  db.prepare('UPDATE app_settings SET public_base_url = ? WHERE id = 1').run(normalized);
  const resolved = resolvePublicBaseUrl();
  res.json({
    ok: true,
    publicBaseUrl: normalized || '',
    effective: resolved.baseUrl || null,
    source: resolved.source,
    warning: resolved.warning || null,
    lanBaseUrl: detectLanBaseUrl() || null,
  });
});

/** One-click: set pay portal base to this host’s LAN IP (LXC/VM). */
app.post('/api/payment-links/config/use-lan', (req, res) => {
  try {
    const port = req.body?.port != null ? Number(req.body.port) : undefined;
    const applied = applyLanPayBaseUrl({ port });
    process.env.PUBLIC_BASE_URL = applied.baseUrl;
    const resolved = resolvePublicBaseUrl();
    db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
      'info',
      'payment-links',
      `Pay portal base set to LAN IP ${applied.baseUrl}`
    );
    res.json({
      ok: true,
      publicBaseUrl: applied.baseUrl,
      lanIp: applied.ip,
      lanBaseUrl: applied.baseUrl,
      effective: resolved.baseUrl || applied.baseUrl,
      source: resolved.source,
      warning: resolved.warning || null,
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Could not detect LAN IP' });
  }
});

app.post('/api/payment-links', (req, res) => {
  try {
    const b = req.body || {};
    const userId = Number(b.userId || b.pppoe_user_id);
    if (!userId) return res.status(400).json({ error: 'userId required' });
    // Optional client hint (panel origin) — ignored when a public URL is configured
    const link = createPaymentLink({
      pppoeUserId: userId,
      months: b.months,
      amount: b.amount,
      ttlHours: b.ttlHours,
      baseUrl: b.baseUrl || b.fallbackOrigin || undefined,
    });
    res.status(201).json(link);
  } catch (e: any) {
    res.status(400).json({ error: e?.message || 'Could not create link' });
  }
});

app.post('/api/payment-links/for-user/:id', (req, res) => {
  try {
    const link = ensureFreshPayLink(
      Number(req.params.id),
      req.body?.baseUrl || req.body?.fallbackOrigin || undefined
    );
    res.json(link);
  } catch (e: any) {
    res.status(400).json({ error: e?.message || 'Could not create link' });
  }
});

app.delete('/api/payment-links/:id', (req, res) => {
  const info = db.prepare('DELETE FROM payment_links WHERE id = ?').run(Number(req.params.id));
  if (!info.changes) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

app.post('/api/payment-links/bulk-delete', (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
    .map((id: unknown) => Number(id))
    .filter((id: number) => Number.isFinite(id) && id > 0);
  if (!ids.length) return res.status(400).json({ error: 'No payment link IDs provided.' });
  const stmt = db.prepare('DELETE FROM payment_links WHERE id = ?');
  let count = 0;
  const wipe = db.transaction((list: number[]) => {
    for (const id of list) {
      const info = stmt.run(id);
      if (info.changes) count++;
    }
  });
  wipe(ids);
  db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
    'info',
    'payment-links',
    `Bulk deleted ${count} payment link(s)`,
  );
  res.json({ ok: true, count });
});

app.get('/api/payment-links/:id/proof', (req, res) => {
  const link = db.prepare('SELECT id, proof_image FROM payment_links WHERE id = ?').get(Number(req.params.id)) as
    | { id: number; proof_image?: string }
    | undefined;
  if (!link?.proof_image) return res.status(404).json({ error: 'No proof image' });
  const rel = String(link.proof_image).replace(/^\/+/, '');
  if (rel.includes('..')) return res.status(400).json({ error: 'Invalid path' });
  const full = path.resolve(process.cwd(), 'data', rel.startsWith('pay-proofs/') ? rel : path.join('pay-proofs', path.basename(rel)));
  const root = path.resolve(process.cwd(), 'data', 'pay-proofs');
  if (!full.startsWith(root) || !fs.existsSync(full)) return res.status(404).json({ error: 'File missing' });
  res.sendFile(full);
});

app.post('/api/payment-links/:id/approve', async (req, res) => {
  try {
    const link = db.prepare('SELECT * FROM payment_links WHERE id = ?').get(Number(req.params.id)) as any;
    if (!link) return res.status(404).json({ error: 'not found' });
    const result = await markPaymentLinkPaid(link.token, link.external_ref || undefined);
    res.json(result);
  } catch (e: any) {
    res.status(400).json({ error: e?.message || 'Approve failed' });
  }
});

app.post('/api/payment-links/:id/reject', (req, res) => {
  try {
    const note = String(req.body?.note || req.body?.review_note || '').trim() || undefined;
    res.json(rejectPaymentProof(Number(req.params.id), note));
  } catch (e: any) {
    res.status(400).json({ error: e?.message || 'Reject failed' });
  }
});

// ---- Usage stats & fair-use ----
app.get('/api/usage/summary', (req, res) => {
  const days = Math.max(1, Math.min(90, Number(req.query.days) || 7));
  const routerId = req.query.routerId ? Number(req.query.routerId) : null;
  res.json(getUsageSummary(days, routerId));
});

app.get('/api/usage/users/:id/history', (req, res) => {
  const user = db.prepare('SELECT username FROM pppoe_users WHERE id = ?').get(Number(req.params.id)) as { username: string } | undefined;
  if (!user) return res.status(404).json({ error: 'not found' });
  const days = Math.max(1, Math.min(90, Number(req.query.days) || 30));
  res.json({ username: user.username, history: getUserUsageHistory(user.username, days) });
});

app.get('/api/usage/detail', async (req, res) => {
  const username = String(req.query.username || '').trim();
  if (!username) return res.status(400).json({ error: 'username is required' });
  const days = Math.max(1, Math.min(90, Number(req.query.days) || 30));
  const hours = Math.max(1, Math.min(48, Number(req.query.hours) || 6));
  try {
    const detail = await getSubscriberUsageDetail(username, { days, hours });
    res.json(detail);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Failed to load usage detail' });
  }
});

app.get('/api/usage/alerts', (_req, res) => {
  res.json({ alerts: listUsageAlerts(150), settings: getFairUseSettings() });
});

app.post('/api/usage/alerts/:id/ack', (req, res) => {
  const row = ackUsageAlert(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

app.get('/api/usage/settings', (_req, res) => res.json(getFairUseSettings()));
app.put('/api/usage/settings', (req, res) => res.json(updateFairUseSettings(req.body || {})));
app.post('/api/usage/poll', async (req, res) => {
  const routerId = req.body?.routerId ? Number(req.body.routerId) : null;
  const r = await pollUsageAndFairUse({ routerId });
  res.json(r);
});

// Fetch existing subscribers from a live MikroTik router by reading /ppp/secret
// and parsing the billing JSON stored in each secret's comment.
function parseSecretComment(comment: unknown): any {
  if (!comment || typeof comment !== 'string') return {};
  const s = comment.trim();
  if (!s.startsWith('{')) return {};
  try {
    const o = JSON.parse(s);
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}
function normStatus(v: unknown): string {
  const s = String(v ?? '').toLowerCase();
  if (/^(active|enabled|online|1|true)$/.test(s)) return 'Active';
  if (/non.?pay/.test(s)) return 'non-payment';
  if (/expire/.test(s)) return 'expired';
  if (/disable/.test(s)) return 'disabled';
  if (/inactive/.test(s)) return 'inactive';
  return s ? String(v) : 'Active';
}

app.post('/api/pppoe/fetch-mikrotik', async (req, res) => {
  const routerId = Number((req.query.routerId ?? req.body?.routerId) || 0);
  const router = db.prepare('SELECT * FROM routers WHERE id = ?').get(routerId) as any;
  if (!router) return res.status(400).json({ error: 'Router not found. Select a router first.' });

  let secrets: any[];
  let profiles: any[];
  let activeNames = new Set<string>();
  try {
    const data = (await withRouter(router, async (api) => {
      const p = (await api.write('/ppp/profile/print')) as any[];
      const s = (await api.write('/ppp/secret/print')) as any[];
      const a = (await api.write('/ppp/active/print')) as any[];
      return { profiles: p, secrets: s, active: a };
    })) as { profiles: any[]; secrets: any[]; active: any[] };
    profiles = data.profiles || [];
    secrets = data.secrets || [];
    activeNames = new Set((data.active || []).map((x) => x.name).filter(Boolean));
  } catch {
    return res.status(502).json({
      error:
        'Could not reach the router API. Check the host, API port and credentials in Router Management, and make sure the RouterOS API service is enabled.',
    });
  }

  const service = router.type === 'ipoe' ? 'ipoe' : 'pppoe';

  // Import PPP profiles first (RouterOS has no price, so keep any existing price).
  // Never overwrite billing plans (type=plan) — those are panel-only references.
  const findProfile = db.prepare('SELECT id, type, ppp_profile FROM profiles WHERE name = ?');
  const insProfile = db.prepare(
    'INSERT INTO profiles (name, rate_limit, price, type) VALUES (?, ?, 0, ?)'
  );
  const updProfile = db.prepare(
    `UPDATE profiles SET rate_limit = ? WHERE name = ? AND coalesce(type, 'pppoe') != 'plan'`
  );
  let profilesImported = 0;
  db.transaction(() => {
    for (const p of profiles) {
      const name = p?.name;
      if (!name) continue;
      const rl = p['rate-limit'] || p.rateLimit || '';
      const existing = findProfile.get(String(name)) as
        | { id: number; type?: string; ppp_profile?: string }
        | undefined;
      if (existing && String(existing.type || '') === 'plan') {
        // Name reserved as a billing plan — do not treat as a PPP profile row.
        continue;
      }
      if (existing) updProfile.run(String(rl), String(name));
      else insProfile.run(String(name), String(rl), 'pppoe');
      profilesImported++;
    }
  })();

  const planPrice: Record<string, number> = {};
  for (const p of db.prepare('SELECT name, price FROM profiles').all() as any[]) planPrice[p.name] = p.price;
  // Comment "plan" is a panel billing plan — store as type=plan pointing at the live PPP profile.
  const ensureBillingPlan = db.prepare(
    `INSERT OR IGNORE INTO profiles (name, rate_limit, price, type, ppp_profile)
     VALUES (?, '', 0, 'plan', ?)`
  );
  const linkPlanProfile = db.prepare(
    `UPDATE profiles SET ppp_profile = COALESCE(NULLIF(trim(ppp_profile), ''), ?)
     WHERE name = ? AND coalesce(type, 'pppoe') = 'plan'`
  );
  const findUser = db.prepare('SELECT id, account_number FROM pppoe_users WHERE username = ?');
  const insUser = db.prepare(
    `INSERT INTO pppoe_users
      (username, password, customer_name, account_number, profile, status, subscription_due, price,
       router_id, service, expiration_profile, contact, email, address, plc_port, lat, lng, online)
     VALUES (@username, @password, @customer_name, @account_number, @profile, @status, @subscription_due, @price,
       @router_id, @service, @expiration_profile, @contact, @email, @address, @plc_port, @lat, @lng, @online)`
  );
  const updUser = db.prepare(
    `UPDATE pppoe_users SET password=@password, customer_name=@customer_name, account_number=@account_number,
       profile=@profile, status=@status, subscription_due=@subscription_due, price=@price, router_id=@router_id,
       service=@service, expiration_profile=@expiration_profile, contact=@contact, email=@email, address=@address,
       plc_port=@plc_port, lat=@lat, lng=@lng, online=@online WHERE id=@id`
  );

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const tx = db.transaction(() => {
    for (const sec of secrets) {
      const username = sec.name;
      if (!username) {
        skipped++;
        continue;
      }
      const meta = parseSecretComment(sec.comment);
      const cust = meta.customer || {};
      // Billing plan always comes from the secret comment — not the live PPP profile
      // (live profile is often non-payments during grace / after expiry switch).
      const commentPlan = String(meta.plan || '').trim();
      const rosProfile = String(sec.profile || '').trim();
      const plan = commentPlan || rosProfile || '15mbps';
      if (commentPlan) {
        // Panel billing plan only — never create a MikroTik /ppp/profile for this name.
        if (!(commentPlan in planPrice)) {
          const linked =
            rosProfile &&
            rosProfile !== commentPlan &&
            !isSystemPppProfileName(rosProfile)
              ? rosProfile
              : null;
          ensureBillingPlan.run(commentPlan, linked);
          planPrice[commentPlan] = 0;
        } else if (
          rosProfile &&
          rosProfile !== commentPlan &&
          !isSystemPppProfileName(rosProfile)
        ) {
          linkPlanProfile.run(rosProfile, commentPlan);
        }
      } else if (!(plan in planPrice)) {
        // No comment plan: fall back to live PPP profile name (already imported above if present).
        insProfile.run(plan, '', 'pppoe');
        planPrice[plan] = 0;
      }
      const disabled = sec.disabled === 'true' || sec.disabled === true;
      const expireProf = String(meta.expireProfile || 'non-payments').trim();
      const existing = findUser.get(username) as any;
      const account = String(meta.accountNumber || existing?.account_number || generateAccountNumber());
      const due = meta.dueDate ? String(meta.dueDate).slice(0, 10) : new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
      let status: string;
      if (disabled) {
        status = 'disabled';
      } else if (
        rosProfile &&
        (rosProfile.toLowerCase() === expireProf.toLowerCase() || /non.?pay/i.test(rosProfile))
      ) {
        status = 'non-payment';
      } else {
        status = normStatus(cust.status);
      }
      const fields = {
        username: String(username),
        password: sec.password || '',
        customer_name: cust.fullName || String(username),
        account_number: account,
        profile: plan,
        status,
        subscription_due: due,
        price: Number(planPrice[plan]) || Number(planPrice[commentPlan]) || 0,
        router_id: router.id,
        service,
        expiration_profile: expireProf || 'default',
        contact: cust.contactNumber || null,
        email: cust.email || null,
        address: cust.address || null,
        plc_port: cust.plcPort != null && cust.plcPort !== '' ? String(cust.plcPort) : null,
        lat: cust.latitude != null ? Number(cust.latitude) : null,
        lng: cust.longitude != null ? Number(cust.longitude) : null,
        online: activeNames.has(String(username)) ? 1 : 0,
      };
      if (existing) {
        updUser.run({ ...fields, id: existing.id });
        updated++;
      } else {
        insUser.run(fields);
        created++;
      }
    }
  });
  tx();

  db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
    'info',
    'mikrotik',
    `Fetched from ${router.name}: ${profilesImported} profiles, ${secrets.length} secrets (${created} new, ${updated} updated), ${activeNames.size} active`
  );
  res.json({
    ok: true,
    fetched: secrets.length,
    created,
    updated,
    skipped,
    profilesImported,
    active: activeNames.size,
    service,
    router: router.name,
  });
});

app.get('/api/pppoe/profiles', async (req, res) => {
  const routerId = req.query.routerId ? Number(req.query.routerId) : null;
  const includeSystem = String(req.query.includeSystem || '') === '1';
  // Billing plan names (type=plan) must never appear on the Profiles tab —
  // they are panel-only references to MikroTik /ppp/profile entries.
  const billingPlanNames = new Set(
    (
      db
        .prepare(`SELECT name FROM profiles WHERE coalesce(type, 'pppoe') = 'plan'`)
        .all() as { name: string }[]
    )
      .map((r) => String(r.name || '').trim())
      .filter(Boolean)
  );
  const dbProfiles = (
    db
      .prepare(
        `SELECT id, name, rate_limit AS rateLimit, price, type FROM profiles
         WHERE coalesce(type, 'pppoe') != 'plan'
         ORDER BY name`
      )
      .all() as any[]
  ).filter(
    (p) =>
      !billingPlanNames.has(String(p.name || '').trim()) &&
      (includeSystem || !isSystemPppProfileName(p.name))
  );
  const router = getRouterById(routerId);
  if (!router?.host || !router?.api_user) {
    return res.json({ profiles: dbProfiles, live: false });
  }
  try {
    const live = await fetchPppProfiles(router);
    const byName = new Map(dbProfiles.map((p) => [p.name, p]));
    const merged = live
      .filter(
        (p) =>
          !billingPlanNames.has(String(p.name || '').trim()) &&
          (includeSystem || !isSystemPppProfileName(p.name))
      )
      .map((p) => {
        const dbp = byName.get(p.name);
        return {
          id: dbp?.id ?? p.id,
          mikrotikId: p.id,
          name: p.name,
          rateLimit: p.rateLimit || dbp?.rateLimit || '',
          price: dbp?.price ?? 0,
          type: dbp?.type || 'pppoe',
          localAddress: p.localAddress,
          remoteAddress: p.remoteAddress,
          live: true,
        };
      });
    // DB-only PPP profile stubs not on the router — still never include billing plans.
    for (const p of dbProfiles) {
      if (!merged.some((m) => m.name === p.name)) {
        merged.push({ ...p, mikrotikId: null, live: false });
      }
    }
    res.json({ profiles: merged, live: true, routerId: router.id, routerName: router.name });
  } catch (e: any) {
    res.status(502).json({
      error: e?.message || 'Could not fetch PPP profiles from MikroTik',
      profiles: dbProfiles,
      live: false,
    });
  }
});

app.post('/api/pppoe/profiles', async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const rateLimit = String(b.rateLimit || b.rate_limit || '').trim();
  const price = Number(b.price) || 0;
  const routerId = b.routerId ? Number(b.routerId) : null;
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (isSystemPppProfileName(name)) {
    return res.status(400).json({ error: 'Cannot manage MikroTik system profiles (default / non-payments) here' });
  }
  const asPlan = db
    .prepare(`SELECT id FROM profiles WHERE name = ? AND coalesce(type, 'pppoe') = 'plan'`)
    .get(name) as { id: number } | undefined;
  if (asPlan) {
    return res.status(409).json({
      error: `"${name}" is a billing plan (panel reference only). Create PPP profiles on the Profiles tab with a different name, or edit the plan under Billing Plans.`,
    });
  }
  const router = getRouterById(routerId);
  if (router?.host && router?.api_user) {
    try {
      await addPppProfile(router, {
        name,
        rateLimit: rateLimit || undefined,
        localAddress: b.localAddress || undefined,
        remoteAddress: b.remoteAddress || undefined,
        comment: b.comment || undefined,
      });
    } catch (e: any) {
      return res.status(502).json({ error: e?.message || 'Could not add PPP profile on MikroTik' });
    }
  }
  const existing = db.prepare('SELECT id, type FROM profiles WHERE name = ?').get(name) as any;
  if (existing) {
    if (String(existing.type || '') === 'plan') {
      return res.status(409).json({ error: `"${name}" is a billing plan, not a PPP profile` });
    }
    db.prepare('UPDATE profiles SET rate_limit = ?, price = ? WHERE id = ?').run(rateLimit, price, existing.id);
    return res.json(db.prepare('SELECT id, name, rate_limit AS rateLimit, price, type FROM profiles WHERE id = ?').get(existing.id));
  }
  const info = db.prepare('INSERT INTO profiles (name, rate_limit, price, type) VALUES (?, ?, ?, ?)').run(name, rateLimit, price, 'pppoe');
  res.status(201).json(db.prepare('SELECT id, name, rate_limit AS rateLimit, price, type FROM profiles WHERE id = ?').get(info.lastInsertRowid));
});

app.put('/api/pppoe/profiles/:id', async (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as any;
  const b = req.body || {};
  const routerId = b.routerId ? Number(b.routerId) : null;
  const name = String(b.name ?? existing?.name ?? '').trim();
  const rateLimit = String(b.rateLimit ?? b.rate_limit ?? existing?.rate_limit ?? '').trim();
  const price = b.price != null ? Number(b.price) : existing?.price ?? 0;
  const router = getRouterById(routerId);

  if (existing && String(existing.type || '') === 'plan') {
    return res.status(400).json({
      error: 'This row is a billing plan (panel reference). Edit it under Billing Plans — it is never written to MikroTik /ppp/profile.',
    });
  }
  const nameIsPlan = db
    .prepare(`SELECT id FROM profiles WHERE name = ? AND coalesce(type, 'pppoe') = 'plan'`)
    .get(name) as { id: number } | undefined;
  if (nameIsPlan) {
    return res.status(409).json({ error: `"${name}" is reserved as a billing plan name` });
  }

  if (router?.host && router?.api_user) {
    try {
      const live = await fetchPppProfiles(router);
      const hit = live.find((p) => p.name === (existing?.name || name) || p.id === String(b.mikrotikId || ''));
      if (hit) {
        await updatePppProfile(router, hit.id, {
          name,
          rateLimit,
          localAddress: b.localAddress,
          remoteAddress: b.remoteAddress,
          comment: b.comment,
        });
      } else {
        await addPppProfile(router, { name, rateLimit: rateLimit || undefined });
      }
    } catch (e: any) {
      return res.status(502).json({ error: e?.message || 'Could not update PPP profile on MikroTik' });
    }
  }

  if (existing) {
    if (isSystemPppProfileName(existing.name) || isSystemPppProfileName(name)) {
      return res.status(400).json({ error: 'Cannot manage MikroTik system profiles (default / non-payments) here' });
    }
    db.prepare('UPDATE profiles SET name = ?, rate_limit = ?, price = ? WHERE id = ?').run(name, rateLimit, price, id);
    return res.json(db.prepare('SELECT id, name, rate_limit AS rateLimit, price, type FROM profiles WHERE id = ?').get(id));
  }
  if (isSystemPppProfileName(name)) {
    return res.status(400).json({ error: 'Cannot manage MikroTik system profiles (default / non-payments) here' });
  }
  const info = db.prepare('INSERT INTO profiles (name, rate_limit, price, type) VALUES (?, ?, ?, ?)').run(name, rateLimit, price, 'pppoe');
  res.status(201).json(db.prepare('SELECT id, name, rate_limit AS rateLimit, price, type FROM profiles WHERE id = ?').get(info.lastInsertRowid));
});

app.delete('/api/pppoe/profiles/:id', async (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as any;
  if (!existing) return res.status(404).json({ error: 'not found' });
  if (String(existing.type || '') === 'plan') {
    return res.status(400).json({
      error: 'This is a billing plan. Delete it under Billing Plans — PPP Profiles only manage MikroTik /ppp/profile.',
    });
  }
  const routerId = req.query.routerId ? Number(req.query.routerId) : req.body?.routerId ? Number(req.body.routerId) : null;
  const inUse = db.prepare('SELECT COUNT(*) AS c FROM pppoe_users WHERE profile = ?').get(existing.name) as { c: number };
  if (inUse.c > 0) {
    return res.status(400).json({ error: `Profile "${existing.name}" is used by ${inUse.c} user(s).` });
  }
  const router = getRouterById(routerId);
  if (router?.host && router?.api_user) {
    try {
      const live = await fetchPppProfiles(router);
      const hit = live.find((p) => p.name === existing.name);
      if (hit) await removePppProfile(router, hit.id);
    } catch (e: any) {
      return res.status(502).json({ error: e?.message || 'Could not remove PPP profile on MikroTik' });
    }
  }
  db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.get('/api/pppoe/active', async (req, res) => {
  const service = String(req.query.service || 'pppoe');
  const routerId = req.query.routerId ? Number(req.query.routerId) : null;
  const wantTraffic = String(req.query.traffic ?? '1') !== '0';
  // fast=1 (default for live polls): no 1s dual-sample sleep — uses counter deltas between polls.
  const fast = String(req.query.fast ?? '1') !== '0';
  const router = getRouterById(routerId);
  if (!router) {
    return res.status(400).json({ error: 'Select a router in the top bar.', sessions: [], live: false });
  }
  if (!router.host || !router.api_user) {
    return res.status(400).json({ error: 'Router API credentials not configured.', sessions: [], live: false });
  }
  try {
    const { secrets, sessions } = await fetchPppSecretsAndActive(router);
    const users = db
      .prepare(
        `SELECT username, customer_name AS customer, profile FROM pppoe_users WHERE service = ? AND router_id = ?`
      )
      .all(service, router.id) as any[];
    const byUser = new Map(users.map((u) => [pppNameKey(u.username), u]));
    const secretByName = new Map(secrets.map((s) => [pppNameKey(s.name), s]));
    const filtered = sessions.filter(
      (s) => !service || s.service === 'any' || !s.service || s.service.includes(service) || service === 'pppoe'
    );
    let traffic: Record<string, { download: number; upload: number }> = {};
    let trafficOk = false;
    if (wantTraffic) {
      try {
        const addresses: Record<string, string> = {};
        for (const s of filtered) {
          if (s.name && s.address && s.address !== '-') addresses[s.name] = s.address;
        }
        traffic = await fetchPppActiveTraffic(router, filtered.map((s) => s.name), { addresses, fast });
        trafficOk = true;
      } catch {
        /* traffic optional — omit rates so the UI keeps the previous reading */
      }
    }
    const trafficByKey = new Map<string, { download: number; upload: number }>();
    for (const [name, t] of Object.entries(traffic)) trafficByKey.set(pppNameKey(name), t);
    const out = filtered.map((s) => {
      const key = pppNameKey(s.name);
      const u = byUser.get(key);
      const sec = secretByName.get(key);
      const t = trafficByKey.get(key);
      const secretProfile = String(sec?.profile || '').trim();
      return {
        username: s.name,
        customer: u?.customer || s.name,
        profile: secretProfile || '—',
        address: s.address,
        uptime: s.uptime,
        caller: s.caller && s.caller !== '-' ? s.caller : '—',
        service: s.service,
        ...(trafficOk
          ? { downloadBps: t?.download ?? 0, uploadBps: t?.upload ?? 0 }
          : {}),
      };
    });
    res.json({
      sessions: out,
      live: true,
      trafficOk,
      routerId: router.id,
      routerName: router.name,
      polledAt: new Date().toISOString(),
    });
  } catch (e: any) {
    res.status(502).json({
      error: e?.message || 'Could not fetch active PPP sessions from MikroTik',
      sessions: [],
      live: false,
      routerId: router.id,
      routerName: router.name,
    });
  }
});

app.get('/api/pppoe/summary', (req, res) => {
  const service = String(req.query.service || 'pppoe');
  const rows = db
    .prepare(
      `SELECT status, subscription_due AS subscriptionDue, nonpayment_since AS nonpaymentSince
       FROM pppoe_users WHERE service = ?`
    )
    .all(service) as { status: string; subscriptionDue: string | null; nonpaymentSince: string | null }[];
  res.json({
    total: rows.length,
    active: rows.filter((r) => String(r.status).toLowerCase() === 'active').length,
    inactive: rows.filter((r) => String(r.status).toLowerCase() === 'inactive').length,
    expired: rows.filter((r) =>
      isExpiredAccount({
        status: r.status,
        panelStatus: r.status,
        subscriptionDue: r.subscriptionDue,
        nonpaymentSince: r.nonpaymentSince,
      })
    ).length,
  });
});

// ---- Servers (live PPPoE servers on selected MikroTik) ----
app.get('/api/pppoe/servers', async (req, res) => {
  const routerId = req.query.routerId ? Number(req.query.routerId) : null;
  const router = getRouterById(routerId);
  if (!router) {
    return res.status(400).json({ error: 'Select a router in the top bar.', servers: [], live: false });
  }
  if (!router.host || !router.api_user) {
    return res.status(400).json({ error: 'Router API credentials not configured.', servers: [], live: false });
  }
  try {
    const servers = await fetchPppoeServers(router);
    res.json({ servers, live: true, routerId: router.id, routerName: router.name });
  } catch (e: any) {
    res.status(502).json({
      error: e?.message || 'Could not fetch PPPoE servers from MikroTik',
      servers: [],
      live: false,
      routerId: router.id,
      routerName: router.name,
    });
  }
});

app.get('/api/billing-plans', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT id, name, rate_limit AS rateLimit, price, ppp_profile AS pppProfile, type
       FROM profiles
       WHERE coalesce(type, 'pppoe') = 'plan'
       ORDER BY name`
    )
    .all() as any[];
  res.json(rows.filter((p) => !isSystemPppProfileName(p.name)));
});

app.post('/api/billing-plans', (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const pppProfile = String(b.pppProfile || b.ppp_profile || b.profile || '').trim();
  const price = Number(b.price) || 0;
  if (!name) return res.status(400).json({ error: 'Plan name is required' });
  if (isSystemPppProfileName(name)) {
    return res.status(400).json({ error: 'default / non-payments are system profiles, not billing plans' });
  }
  if (!pppProfile) return res.status(400).json({ error: 'Select a MikroTik PPP profile for this plan' });
  if (isSystemPppProfileName(pppProfile)) {
    return res.status(400).json({ error: 'Link a customer PPP profile, not default / non-payments' });
  }
  if (name === pppProfile) {
    return res.status(400).json({
      error:
        'Plan name must differ from the MikroTik profile name. The plan is only a panel label that points at an existing /ppp/profile.',
    });
  }
  // Reference only — copy rate limit for display; never create a MikroTik /ppp/profile.
  const linked = db
    .prepare(`SELECT rate_limit FROM profiles WHERE name = ? AND coalesce(type, 'pppoe') != 'plan'`)
    .get(pppProfile) as { rate_limit?: string } | undefined;
  const rateLimit = String(b.rateLimit || b.rate_limit || linked?.rate_limit || '').trim();
  const exists = db.prepare('SELECT id, type FROM profiles WHERE name = ?').get(name) as
    | { id: number; type?: string }
    | undefined;
  if (exists) {
    if (String(exists.type || '') === 'plan') {
      return res.status(409).json({ error: 'A plan with that name already exists' });
    }
    return res.status(409).json({
      error: `Name "${name}" is already used by a PPP profile. Use a different plan name.`,
    });
  }
  const info = db
    .prepare('INSERT INTO profiles (name, rate_limit, price, type, ppp_profile) VALUES (?, ?, ?, ?, ?)')
    .run(name, rateLimit, price, 'plan', pppProfile);
  res
    .status(201)
    .json(
      db
        .prepare(
          'SELECT id, name, rate_limit AS rateLimit, price, ppp_profile AS pppProfile FROM profiles WHERE id = ?'
        )
        .get(info.lastInsertRowid)
    );
});

app.put('/api/billing-plans/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as any;
  if (!existing) return res.status(404).json({ error: 'not found' });
  if (isSystemPppProfileName(existing.name)) {
    return res.status(400).json({ error: 'default / non-payments are system profiles, not billing plans' });
  }
  const b = req.body || {};
  const name = String(b.name ?? existing.name).trim();
  const pppProfile = String(
    b.pppProfile ?? b.ppp_profile ?? b.profile ?? existing.ppp_profile ?? ''
  ).trim();
  const price = b.price != null ? Number(b.price) : existing.price;
  if (!name) return res.status(400).json({ error: 'Plan name is required' });
  if (isSystemPppProfileName(name)) {
    return res.status(400).json({ error: 'default / non-payments are system profiles, not billing plans' });
  }
  if (!pppProfile) return res.status(400).json({ error: 'Select a MikroTik PPP profile for this plan' });
  if (isSystemPppProfileName(pppProfile)) {
    return res.status(400).json({ error: 'Link a customer PPP profile, not default / non-payments' });
  }
  if (name === pppProfile) {
    return res.status(400).json({
      error:
        'Plan name must differ from the MikroTik profile name. The plan is only a panel label that points at an existing /ppp/profile.',
    });
  }
  const linked = db
    .prepare(`SELECT rate_limit FROM profiles WHERE name = ? AND coalesce(type, 'pppoe') != 'plan'`)
    .get(pppProfile) as { rate_limit?: string } | undefined;
  const rateLimit = String(
    b.rateLimit ?? b.rate_limit ?? linked?.rate_limit ?? existing.rate_limit ?? ''
  ).trim();
  const conflict = db.prepare('SELECT id, type FROM profiles WHERE name = ? AND id != ?').get(name, id) as
    | { id: number; type?: string }
    | undefined;
  if (conflict) {
    return res.status(409).json({
      error:
        String(conflict.type || '') === 'plan'
          ? 'A plan with that name already exists'
          : `Name "${name}" is already used by a PPP profile. Use a different plan name.`,
    });
  }
  if (name !== existing.name) {
    db.prepare('UPDATE pppoe_users SET profile = ? WHERE profile = ?').run(name, existing.name);
  }
  // type=plan: panel reference only — never pushes /ppp/profile to MikroTik.
  db.prepare(
    `UPDATE profiles SET name = ?, rate_limit = ?, price = ?, ppp_profile = ?, type = 'plan' WHERE id = ?`
  ).run(name, rateLimit, price, pppProfile, id);
  res.json(
    db
      .prepare(
        'SELECT id, name, rate_limit AS rateLimit, price, ppp_profile AS pppProfile FROM profiles WHERE id = ?'
      )
      .get(id)
  );
});

app.delete('/api/billing-plans/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as any;
  if (!existing) return res.status(404).json({ error: 'not found' });
  if (String(existing.type || '') !== 'plan') {
    return res.status(400).json({ error: 'Not a billing plan. Use PPP Profiles to manage MikroTik profiles.' });
  }
  const inUse = db.prepare('SELECT COUNT(*) AS c FROM pppoe_users WHERE profile = ?').get(existing.name) as { c: number };
  if (inUse.c > 0) {
    return res.status(400).json({ error: `Plan "${existing.name}" is used by ${inUse.c} user(s).` });
  }
  db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ---- IPoE (DHCP leases / servers / profiles / billing plans) ----
function normalizeMac(mac: string): string {
  return String(mac || '')
    .toUpperCase()
    .replace(/[^A-F0-9]/g, '')
    .replace(/(.{2})(?=.)/g, '$1:');
}

function formatSpeedMbps(down: number, up: number): string {
  const d = Number(down) || 0;
  const u = Number(up) || 0;
  return `${d}↓ / ${u}↑ Mbps`;
}

type IpoeBillingCandidate = {
  mac: string;
  name: string;
  due: string;
  payment: string;
  daysOverdue: number;
  hoursOverdue: number;
  leaseId: string | null;
  blocked: boolean;
  action: 'expire' | 'disable';
};

async function loadIpoeLeaseBillingState(routerId: number | null) {
  const s = getNotifySettingsRaw();
  const graceHours = Number(s.autodisable_hours) || 24;
  const metaRows = db.prepare('SELECT * FROM ipoe_lease_meta').all() as any[];
  const now = Date.now();

  let liveByMac = new Map<string, { id: string; blocked: boolean }>();
  const router = getRouterById(routerId);
  if (router?.host && router?.api_user) {
    try {
      const leases = await fetchDhcpLeases(router);
      liveByMac = new Map(
        leases.map((l) => [
          normalizeMac(l.macAddress || l.activeMac),
          { id: l.id, blocked: !!l.blocked },
        ])
      );
    } catch {
      /* preview without live ids still useful */
    }
  }

  const toExpire: IpoeBillingCandidate[] = [];
  const toDisable: IpoeBillingCandidate[] = [];

  for (const m of metaRows) {
    const due = String(m.due_at || '').slice(0, 10);
    if (!due || !/^\d{4}-\d{2}-\d{2}$/.test(due)) continue;
    const dueMs = Date.parse(`${due}T00:00:00Z`);
    if (!Number.isFinite(dueMs)) continue;
    const hoursOverdue = (now - dueMs) / 3600000;
    if (hoursOverdue < 0) continue;

    const mac = normalizeMac(m.mac);
    const live = liveByMac.get(mac);
    const payment = String(m.payment_status || 'Active');
    const payLow = payment.toLowerCase();
    const daysOverdue = Math.floor(hoursOverdue / 24);
    const candidate: IpoeBillingCandidate = {
      mac,
      name: m.name || mac,
      due,
      payment,
      daysOverdue,
      hoursOverdue: Math.round(hoursOverdue * 10) / 10,
      leaseId: live?.id || null,
      blocked: !!live?.blocked,
      action: 'expire',
    };

    if (live?.blocked) continue;

    if (hoursOverdue >= graceHours) {
      toDisable.push({ ...candidate, action: 'disable' });
    } else if (!/non.?pay|disabled|blocked/i.test(payLow)) {
      toExpire.push({ ...candidate, action: 'expire' });
    }
  }

  return {
    toExpire,
    toDisable,
    graceHours,
    autodisableEnabled: !!s.autodisable_enabled,
    routerId,
  };
}

async function previewIpoeBillingEnforcement(routerId: number | null) {
  return loadIpoeLeaseBillingState(routerId);
}

async function executeIpoeBillingEnforcement(routerId: number | null) {
  const preview = await loadIpoeLeaseBillingState(routerId);
  const router = getRouterById(routerId);
  let markedNonPayment = 0;
  let blocked = 0;
  let routerErrors = 0;
  const expired: IpoeBillingCandidate[] = [];
  const disabledLeases: IpoeBillingCandidate[] = [];

  for (const c of preview.toExpire) {
    db.prepare(
      `UPDATE ipoe_lease_meta SET payment_status = 'Non-payment' WHERE mac = ?`
    ).run(c.mac);
    markedNonPayment++;
    expired.push({ ...c, payment: 'Non-payment' });
  }

  for (const c of preview.toDisable) {
    db.prepare(
      `UPDATE ipoe_lease_meta SET payment_status = 'Disabled' WHERE mac = ?`
    ).run(c.mac);
    if (router?.host && router?.api_user && c.leaseId) {
      try {
        await setDhcpLeaseBlocked(router, c.leaseId, true);
        blocked++;
        disabledLeases.push({ ...c, payment: 'Disabled', blocked: true });
      } catch {
        routerErrors++;
      }
    } else {
      // No live lease id — still mark disabled in panel meta
      blocked++;
      disabledLeases.push({ ...c, payment: 'Disabled' });
    }
  }

  if (markedNonPayment || blocked) {
    db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
      'warning',
      'billing',
      `IPoE recheck: ${markedNonPayment} non-payment, ${blocked} blocked (grace ${preview.graceHours}h)`
    );
  }

  return {
    markedNonPayment,
    blocked,
    routerErrors,
    expired,
    disabledLeases,
    graceHours: preview.graceHours,
  };
}

app.get('/api/ipoe/leases', async (req, res) => {
  const routerId = req.query.routerId ? Number(req.query.routerId) : null;
  const filter = String(req.query.filter || 'all'); // all | online | offline
  const router = getRouterById(routerId);
  if (!router) return res.status(400).json({ error: 'Select a router in the top bar.', leases: [], live: false });
  if (!router.host || !router.api_user) {
    return res.status(400).json({ error: 'Router API credentials not configured.', leases: [], live: false });
  }
  try {
    const leases = await fetchDhcpLeases(router);
    const plans = db.prepare('SELECT * FROM ipoe_plans').all() as any[];
    const profiles = db.prepare('SELECT * FROM ipoe_profiles').all() as any[];
    const metaRows = db.prepare('SELECT * FROM ipoe_lease_meta').all() as any[];
    const metaByMac = new Map(metaRows.map((m) => [normalizeMac(m.mac), m]));
    const planByName = new Map(plans.map((p) => [p.name, p]));
    const profileByName = new Map(profiles.map((p) => [p.name, p]));

    const mapped = leases.map((l) => {
      const mac = normalizeMac(l.macAddress || l.activeMac);
      const meta = metaByMac.get(mac);
      const planName = meta?.plan_name || plans[0]?.name || '';
      const plan = planByName.get(planName);
      const profile = plan?.profile_name ? profileByName.get(plan.profile_name) : null;
      const online = /bound|waiting/i.test(l.status) ? /bound/i.test(l.status) : !!l.activeAddress;
      const down = plan?.download_mbps ?? profile?.download_mbps ?? 0;
      const up = plan?.upload_mbps ?? profile?.upload_mbps ?? 0;
      return {
        id: l.id,
        name: meta?.name || l.hostName || mac || l.address || '—',
        address: l.activeAddress || l.address || '—',
        mac,
        host: l.hostName || meta?.name || '—',
        plan: planName,
        speed: formatSpeedMbps(down, up),
        downloadMbps: down,
        uploadMbps: up,
        downloadBps: 0,
        uploadBps: 0,
        due: meta?.due_at || '',
        payment: meta?.payment_status || 'Active',
        status: l.blocked ? 'Blocked' : online ? 'Online' : 'Offline',
        online,
        server: l.activeServer || l.server || '—',
        expires: l.expiresAfter || '—',
        lastSeen: l.lastSeen || '—',
        blocked: l.blocked,
        comment: l.comment || meta?.comment || '',
      };
    });

    // Live traffic from simple queues matched by lease IP (when configured).
    const onlineIps = mapped.filter((x) => x.online && x.address && x.address !== '—').map((x) => x.address);
    if (onlineIps.length) {
      try {
        const traffic = await fetchLeaseTrafficByIp(router, onlineIps);
        for (const row of mapped) {
          const t = traffic[row.address];
          if (t) {
            row.downloadBps = t.download;
            row.uploadBps = t.upload;
          }
        }
      } catch {
        /* optional */
      }
    }

    const filtered =
      filter === 'online' ? mapped.filter((x) => x.online && !x.blocked) : filter === 'offline' ? mapped.filter((x) => !x.online || x.blocked) : mapped;

    res.json({ leases: filtered, live: true, routerId: router.id, routerName: router.name, plans, profiles });
  } catch (e: any) {
    res.status(502).json({
      error: e?.message || 'Could not fetch DHCP leases from MikroTik',
      leases: [],
      live: false,
    });
  }
});

app.put('/api/ipoe/leases/:mac', async (req, res) => {
  const mac = normalizeMac(decodeURIComponent(req.params.mac));
  const b = req.body || {};
  const routerId = b.routerId ? Number(b.routerId) : null;
  const prevMeta = db.prepare('SELECT * FROM ipoe_lease_meta WHERE mac = ?').get(mac) as any;
  const prevPayment = String(prevMeta?.payment_status || '');
  const becomingActive = b.payment != null || b.payment_status != null
    ? /active/i.test(String(b.payment ?? b.payment_status))
    : false;
  const wasRestricted = /non.?pay|disabled|blocked/i.test(prevPayment);

  db.prepare(
    `INSERT INTO ipoe_lease_meta (mac, name, plan_name, due_at, payment_status, comment)
     VALUES (@mac, @name, @plan_name, @due_at, @payment_status, @comment)
     ON CONFLICT(mac) DO UPDATE SET
       name=COALESCE(@name, name),
       plan_name=COALESCE(@plan_name, plan_name),
       due_at=COALESCE(@due_at, due_at),
       payment_status=COALESCE(@payment_status, payment_status),
       comment=COALESCE(@comment, comment)`
  ).run({
    mac,
    name: b.name ?? null,
    plan_name: b.plan ?? b.plan_name ?? null,
    due_at: b.due ?? b.due_at ?? null,
    payment_status: b.payment ?? b.payment_status ?? null,
    comment: b.comment ?? null,
  });

  let sessionRefresh: { bounced: boolean; waitMs: number; error?: string } | null = null;
  const router = getRouterById(routerId);
  const leaseId = b.id ? String(b.id) : null;

  // Payment restore of a restricted lease: briefly block then unblock to refresh DHCP binding.
  if (becomingActive && wasRestricted && router?.host && router?.api_user && leaseId) {
    try {
      await setDhcpLeaseBlocked(router, leaseId, true);
      await new Promise((r) => setTimeout(r, 2000));
      await setDhcpLeaseBlocked(router, leaseId, false);
      sessionRefresh = { bounced: true, waitMs: 2000 };
    } catch (e: any) {
      try {
        await setDhcpLeaseBlocked(router, leaseId, false);
      } catch {
        /* best-effort */
      }
      sessionRefresh = { bounced: false, waitMs: 2000, error: e?.message || String(e) };
    }
  } else if (b.blocked != null && routerId && leaseId) {
    if (router?.host && router?.api_user) {
      try {
        await setDhcpLeaseBlocked(router, String(leaseId), !!b.blocked);
      } catch (e: any) {
        return res.status(502).json({ error: e?.message || 'Could not update lease on MikroTik' });
      }
    }
  }
  res.json({ ok: true, mac, sessionRefresh });
});

app.post('/api/ipoe/leases/:mac/toggle-block', async (req, res) => {
  const mac = normalizeMac(decodeURIComponent(req.params.mac));
  const routerId = Number(req.body?.routerId || req.query.routerId || 0);
  const leaseId = String(req.body?.id || '');
  const blocked = !!req.body?.blocked;
  const router = getRouterById(routerId);
  if (!router?.host || !router?.api_user) return res.status(400).json({ error: 'Router API credentials not configured.' });
  if (!leaseId) return res.status(400).json({ error: 'Lease id is required' });
  try {
    await setDhcpLeaseBlocked(router, leaseId, blocked);
    res.json({ ok: true, mac, blocked });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || 'Could not block/unblock lease on MikroTik' });
  }
});

app.get('/api/ipoe/servers', async (req, res) => {
  const routerId = req.query.routerId ? Number(req.query.routerId) : null;
  const router = getRouterById(routerId);
  if (!router) return res.status(400).json({ error: 'Select a router in the top bar.', servers: [], live: false });
  if (!router.host || !router.api_user) {
    return res.status(400).json({ error: 'Router API credentials not configured.', servers: [], live: false });
  }
  try {
    const servers = await fetchDhcpServers(router);
    res.json({
      servers: servers.map((s) => ({
        id: s.id,
        name: s.name,
        interface: s.interface,
        pool: s.addressPool,
        lease: s.leaseTime,
        status: s.disabled ? 'Disabled' : 'Enabled',
        disabled: s.disabled,
      })),
      live: true,
      routerId: router.id,
      routerName: router.name,
    });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || 'Could not fetch DHCP servers', servers: [], live: false });
  }
});

app.post('/api/ipoe/servers', async (req, res) => {
  const b = req.body || {};
  const router = getRouterById(Number(b.routerId || 0));
  if (!router?.host || !router?.api_user) return res.status(400).json({ error: 'Router API credentials not configured.' });
  if (!b.name || !b.interface || !b.pool) return res.status(400).json({ error: 'name, interface and pool are required' });
  try {
    await addDhcpServer(router, {
      name: String(b.name),
      interface: String(b.interface),
      addressPool: String(b.pool),
      leaseTime: b.lease ? String(b.lease) : undefined,
    });
    res.status(201).json({ ok: true });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || 'Could not add DHCP server' });
  }
});

app.put('/api/ipoe/servers/:id', async (req, res) => {
  const b = req.body || {};
  const router = getRouterById(Number(b.routerId || 0));
  if (!router?.host || !router?.api_user) return res.status(400).json({ error: 'Router API credentials not configured.' });
  try {
    await updateDhcpServer(router, req.params.id, {
      name: b.name,
      interface: b.interface,
      addressPool: b.pool,
      leaseTime: b.lease,
      disabled: b.disabled,
    });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || 'Could not update DHCP server' });
  }
});

app.delete('/api/ipoe/servers/:id', async (req, res) => {
  const routerId = Number(req.query.routerId || req.body?.routerId || 0);
  const router = getRouterById(routerId);
  if (!router?.host || !router?.api_user) return res.status(400).json({ error: 'Router API credentials not configured.' });
  try {
    await removeDhcpServer(router, req.params.id);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || 'Could not delete DHCP server' });
  }
});

app.get('/api/ipoe/profiles', (_req, res) => {
  res.json(
    db
      .prepare(
        `SELECT id, name, download_mbps AS downloadMbps, upload_mbps AS uploadMbps, max_limit AS maxLimit FROM ipoe_profiles ORDER BY name`
      )
      .all()
  );
});

app.post('/api/ipoe/profiles', (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  const down = Number(b.downloadMbps ?? b.download_mbps) || 0;
  const up = Number(b.uploadMbps ?? b.upload_mbps) || 0;
  const maxLimit = String(b.maxLimit || b.max_limit || `${down}M/${up}M`);
  try {
    const info = db
      .prepare('INSERT INTO ipoe_profiles (name, download_mbps, upload_mbps, max_limit) VALUES (?, ?, ?, ?)')
      .run(name, down, up, maxLimit);
    res.status(201).json(db.prepare('SELECT id, name, download_mbps AS downloadMbps, upload_mbps AS uploadMbps, max_limit AS maxLimit FROM ipoe_profiles WHERE id = ?').get(info.lastInsertRowid));
  } catch {
    res.status(409).json({ error: 'Profile name already exists' });
  }
});

app.put('/api/ipoe/profiles/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM ipoe_profiles WHERE id = ?').get(id) as any;
  if (!existing) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const name = String(b.name ?? existing.name).trim();
  const down = b.downloadMbps != null ? Number(b.downloadMbps) : existing.download_mbps;
  const up = b.uploadMbps != null ? Number(b.uploadMbps) : existing.upload_mbps;
  const maxLimit = String(b.maxLimit ?? existing.max_limit ?? `${down}M/${up}M`);
  db.prepare('UPDATE ipoe_profiles SET name=?, download_mbps=?, upload_mbps=?, max_limit=? WHERE id=?').run(name, down, up, maxLimit, id);
  if (name !== existing.name) {
    db.prepare('UPDATE ipoe_plans SET profile_name = ? WHERE profile_name = ?').run(name, existing.name);
  }
  // Keep denormalized plan speeds in sync when profile rates change.
  db.prepare(
    'UPDATE ipoe_plans SET download_mbps = ?, upload_mbps = ? WHERE profile_name = ?'
  ).run(down, up, name);
  res.json(db.prepare('SELECT id, name, download_mbps AS downloadMbps, upload_mbps AS uploadMbps, max_limit AS maxLimit FROM ipoe_profiles WHERE id = ?').get(id));
});

app.delete('/api/ipoe/profiles/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM ipoe_profiles WHERE id = ?').get(id) as any;
  if (!existing) return res.status(404).json({ error: 'not found' });
  const inUse = db.prepare('SELECT COUNT(*) AS c FROM ipoe_plans WHERE profile_name = ?').get(existing.name) as { c: number };
  if (inUse.c > 0) return res.status(400).json({ error: `Profile is used by ${inUse.c} billing plan(s).` });
  db.prepare('DELETE FROM ipoe_profiles WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.get('/api/ipoe/plans', (_req, res) => {
  res.json(
    db
      .prepare(
        `SELECT id, name, price, cycle, profile_name AS profile, download_mbps AS downloadMbps, upload_mbps AS uploadMbps FROM ipoe_plans ORDER BY name`
      )
      .all()
      .map((p: any) => ({
        ...p,
        speed: formatSpeedMbps(p.downloadMbps, p.uploadMbps),
      }))
  );
});

app.post('/api/ipoe/plans', (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  const profile = String(b.profile || b.profile_name || '').trim();
  let down = Number(b.downloadMbps) || 0;
  let up = Number(b.uploadMbps) || 0;
  if (profile) {
    const pr = db.prepare('SELECT * FROM ipoe_profiles WHERE name = ?').get(profile) as any;
    if (pr) {
      down = down || pr.download_mbps;
      up = up || pr.upload_mbps;
    }
  }
  try {
    const info = db
      .prepare(
        'INSERT INTO ipoe_plans (name, price, cycle, profile_name, download_mbps, upload_mbps) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(name, Number(b.price) || 0, String(b.cycle || 'Monthly'), profile || null, down, up);
    const row = db.prepare('SELECT id, name, price, cycle, profile_name AS profile, download_mbps AS downloadMbps, upload_mbps AS uploadMbps FROM ipoe_plans WHERE id = ?').get(info.lastInsertRowid) as any;
    res.status(201).json({ ...row, speed: formatSpeedMbps(row.downloadMbps, row.uploadMbps) });
  } catch {
    res.status(409).json({ error: 'Plan name already exists' });
  }
});

app.put('/api/ipoe/plans/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM ipoe_plans WHERE id = ?').get(id) as any;
  if (!existing) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const name = String(b.name ?? existing.name).trim();
  const profile = String(b.profile ?? existing.profile_name ?? '').trim();
  let down = b.downloadMbps != null ? Number(b.downloadMbps) : existing.download_mbps;
  let up = b.uploadMbps != null ? Number(b.uploadMbps) : existing.upload_mbps;
  if (profile && (b.profile != null || b.profile_name != null)) {
    const pr = db.prepare('SELECT * FROM ipoe_profiles WHERE name = ?').get(profile) as any;
    if (pr && b.downloadMbps == null) {
      down = pr.download_mbps;
      up = pr.upload_mbps;
    }
  }
  db.prepare(
    'UPDATE ipoe_plans SET name=?, price=?, cycle=?, profile_name=?, download_mbps=?, upload_mbps=? WHERE id=?'
  ).run(name, b.price != null ? Number(b.price) : existing.price, String(b.cycle ?? existing.cycle), profile || null, down, up, id);
  const row = db.prepare('SELECT id, name, price, cycle, profile_name AS profile, download_mbps AS downloadMbps, upload_mbps AS uploadMbps FROM ipoe_plans WHERE id = ?').get(id) as any;
  res.json({ ...row, speed: formatSpeedMbps(row.downloadMbps, row.uploadMbps) });
});

app.delete('/api/ipoe/plans/:id', (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM ipoe_plans WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ---- Clients Map ----
const FALLBACK_MAP_LAT = 13.918665341879885;
const FALLBACK_MAP_LNG = 120.93887161534413;

function getMapDefaultCenter(): { lat: number; lng: number } {
  const row = db
    .prepare('SELECT map_default_lat AS lat, map_default_lng AS lng FROM app_settings WHERE id = 1')
    .get() as { lat: number | null; lng: number | null } | undefined;
  const lat = Number(row?.lat);
  const lng = Number(row?.lng);
  return {
    lat: Number.isFinite(lat) ? lat : FALLBACK_MAP_LAT,
    lng: Number.isFinite(lng) ? lng : FALLBACK_MAP_LNG,
  };
}

// Derive a stable pseudo-value from a client id (so traffic/usage/ports look
// consistent between refreshes rather than jumping randomly).
function seeded(id: number, salt: number, mod: number) {
  return ((id * 2654435761 + salt * 40503) >>> 0) % mod;
}

app.get('/api/map', async (req, res) => {
  const routerId = req.query.routerId ? Number(req.query.routerId) : null;
  const naps = db.prepare(
    `SELECT id, name, kind, lat, lng, ports, parent_id AS parentId,
            code, status, address, splitter_ratio AS splitterRatio, pon_port AS ponPort,
            host, snmp_port AS snmpPort, snmp_community AS snmpCommunity,
            vendor, model, sys_name AS sysName, firmware, last_probe_at AS lastProbeAt, probe_error AS probeError
     FROM naps`
  ).all();
  const clientSql = `
      SELECT u.id, u.username, u.customer_name AS customer, u.status, u.online, u.lat, u.lng,
              u.nap_id AS napId, u.router_id AS routerId, u.service, u.account_number AS account,
              u.profile AS plan, u.subscription_due AS due, u.plc_port AS plcPort, u.address,
              n.name AS napName, n.parent_id AS oltId,
              o.name AS oltName,
              r.name AS serverName
       FROM pppoe_users u
       LEFT JOIN naps n ON n.id = u.nap_id
       LEFT JOIN naps o ON o.id = n.parent_id
       LEFT JOIN routers r ON r.id = u.router_id
       WHERE u.lat IS NOT NULL AND u.lng IS NOT NULL
       ${routerId ? 'AND u.router_id = ?' : ''}`;
  const clients = (routerId
    ? db.prepare(clientSql).all(routerId)
    : db.prepare(clientSql).all()) as any[];

  const enrichForRouter = async (rid: number, subset: any[]) => {
    const router = getRouterById(rid);
    if (!router?.host || !router?.api_user || subset.length === 0) return;
    try {
      const [secrets, sessions] = await Promise.all([fetchPppSecrets(router), fetchPppActive(router)]);
      const enriched = enrichPppUsersFromLive(subset, secrets, sessions);
      for (let i = 0; i < subset.length; i++) {
        subset[i].status = enriched[i].status;
        subset[i].online = enriched[i].online;
        if (enriched[i].profile) subset[i].plan = enriched[i].profile;
      }
    } catch {
      /* keep DB rows */
    }
  };

  if (routerId) {
    await enrichForRouter(routerId, clients);
  } else {
    const byRouter = new Map<number, any[]>();
    for (const c of clients) {
      const rid = c.routerId || 1;
      if (!byRouter.has(rid)) byRouter.set(rid, []);
      byRouter.get(rid)!.push(c);
    }
    await Promise.all([...byRouter.entries()].map(([rid, subset]) => enrichForRouter(rid, subset)));
  }

  const mapDefault = getMapDefaultCenter();
  const oltPos = db.prepare("SELECT lat, lng FROM naps WHERE kind = 'olt' ORDER BY id LIMIT 1").get() as
    | { lat: number; lng: number }
    | undefined;
  const baseLat = oltPos?.lat ?? mapDefault.lat;
  const baseLng = oltPos?.lng ?? mapDefault.lng;
  const servers = (db.prepare('SELECT id, name, host, status, lat, lng, address FROM routers ORDER BY id').all() as any[]).map(
    (s, i) => ({
      id: s.id,
      name: s.name,
      host: s.host,
      status: s.status,
      address: s.address || '',
      lat: s.lat != null ? Number(s.lat) : baseLat - 0.0015 - i * 0.0006,
      lng: s.lng != null ? Number(s.lng) : baseLng - 0.0025 - i * 0.0004,
    })
  );
  clients.forEach((c) => {
    c.online = !!c.online;
    const napName = c.napName || '-';
    const oltName = c.oltName || 'OLT Main Server';
    const serverName = c.serverName || 'Main Server';
    const pon = (seeded(c.id, 1, 16) + 1); // upstream/PON port on the OLT
    const plc = c.plcPort ? Number(c.plcPort) : seeded(c.id, 2, 8) + 1;
    c.plcPort = plc;
    c.upstreamPort = pon;
    c.oltName = oltName;
    c.serverName = serverName;
    // Live-ish traffic (bps) and cumulative usage (GB), stable per client.
    c.rxBps = c.online ? 200 + seeded(c.id, 3, 900) + Math.floor(Math.random() * 120) : 0;
    c.txBps = c.online ? 500 + seeded(c.id, 4, 1600) + Math.floor(Math.random() * 200) : 0;
    c.rxGB = Number((0.5 + seeded(c.id, 5, 5000) / 500).toFixed(2));
    c.txGB = Number((10 + seeded(c.id, 6, 30000) / 100).toFixed(1));
    c.topology = `${serverName} > ${oltName} > PON${pon} > ${napName} > PLC${plc}`;
  });
  const isActive = (c: any) => {
    const s = String(c.status || '').toLowerCase();
    return s === 'active' || s === '';
  };
  const totalClients = (db.prepare('SELECT COUNT(*) AS c FROM pppoe_users').get() as any).c;
  const withoutLocation = (db.prepare('SELECT COUNT(*) AS c FROM pppoe_users WHERE lat IS NULL').get() as any).c;
  const olts = (db.prepare("SELECT COUNT(*) AS c FROM naps WHERE kind = 'olt'").get() as any).c;
  const napCount = (db.prepare("SELECT COUNT(*) AS c FROM naps WHERE kind = 'nap'").get() as any).c;
  const onlineOnu = clients.filter((c) => c.online && isActive(c)).length;
  const offlineOnu = clients.filter((c) => isActive(c) && !c.online).length;
  const connectors = (db.prepare('SELECT id, kind, from_id AS fromId, to_id AS toId, points FROM map_connectors').all() as any[]).map(
    (c) => ({ ...c, points: JSON.parse(c.points || '[]') })
  );
  res.json({
    naps,
    clients,
    servers,
    connectors,
    defaultCenter: mapDefault,
    stats: { servers: servers.length, olts, naps: napCount, totalClients, withoutLocation, onlineOnu, offlineOnu },
  });
});

app.get('/api/map/default-center', (_req, res) => {
  res.json(getMapDefaultCenter());
});

app.put('/api/map/default-center', (req, res) => {
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: 'Valid latitude and longitude are required.' });
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ error: 'Latitude must be −90…90 and longitude −180…180.' });
  }
  db.prepare('UPDATE app_settings SET map_default_lat = ?, map_default_lng = ? WHERE id = 1').run(lat, lng);
  res.json(getMapDefaultCenter());
});

// ---- OLTs (Network tab: device by IP + probe) ----
const OLT_SELECT = `SELECT id, name, kind, lat, lng, ports, parent_id AS parentId,
  code, status, address, splitter_ratio AS splitterRatio, pon_port AS ponPort,
  host, snmp_port AS snmpPort, snmp_community AS snmpCommunity,
  vendor, model, sys_name AS sysName, firmware, last_probe_at AS lastProbeAt, probe_error AS probeError
  FROM naps WHERE kind = 'olt'`;

function applyOltProbe(id: number, probe: Awaited<ReturnType<typeof probeOlt>>) {
  const status = probe.online ? 'online' : 'offline';
  db.prepare(
    `UPDATE naps SET status=?, vendor=COALESCE(?, vendor), model=COALESCE(?, model),
      sys_name=COALESCE(?, sys_name), firmware=COALESCE(?, firmware),
      last_probe_at=?, probe_error=? WHERE id=?`
  ).run(
    status,
    probe.vendor,
    probe.model,
    probe.sysName,
    probe.firmware,
    new Date().toISOString(),
    probe.error || null,
    id
  );
  return status;
}

app.get('/api/olts', async (_req, res) => {
  const rows = db.prepare(`${OLT_SELECT} ORDER BY id`).all() as any[];
  const out = [];
  for (const row of rows) {
    if (row.host) {
      try {
        const probe = await probeOlt({
          host: row.host,
          snmpPort: row.snmpPort || 161,
          snmpCommunity: row.snmpCommunity || 'public',
        });
        applyOltProbe(row.id, probe);
        out.push({
          ...row,
          status: probe.online ? 'online' : 'offline',
          vendor: probe.vendor || row.vendor,
          model: probe.model || row.model,
          sysName: probe.sysName || row.sysName,
          firmware: probe.firmware || row.firmware,
          lastProbeAt: new Date().toISOString(),
          probeError: probe.error || null,
          live: true,
          online: probe.online,
        });
        continue;
      } catch (e: any) {
        out.push({ ...row, status: 'offline', online: false, live: false, probeError: e?.message || 'probe failed' });
        continue;
      }
    }
    out.push({ ...row, online: row.status === 'online', live: false });
  }
  res.json(out);
});

app.post('/api/olts/test', async (req, res) => {
  const b = req.body || {};
  const host = String(b.host || '').trim();
  if (!host) return res.status(400).json({ error: 'host / IP is required' });
  const probe = await probeOlt({
    host,
    snmpPort: b.snmpPort != null ? Number(b.snmpPort) : 161,
    snmpCommunity: b.snmpCommunity ? String(b.snmpCommunity) : 'public',
  });
  res.json(probe);
});

app.post('/api/olts', async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const host = String(b.host || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!host) return res.status(400).json({ error: 'IP address / host is required' });

  const snmpPort = b.snmpPort != null ? Number(b.snmpPort) : 161;
  const snmpCommunity = b.snmpCommunity ? String(b.snmpCommunity).trim() : 'public';
  const ports = Number(b.ports) || 8;
  const mapDefault = getMapDefaultCenter();
  const lat = b.lat != null ? Number(b.lat) : mapDefault.lat;
  const lng = b.lng != null ? Number(b.lng) : mapDefault.lng;

  const probe = await probeOlt({ host, snmpPort, snmpCommunity });
  const status = probe.online ? 'online' : 'offline';
  const info = db
    .prepare(
      `INSERT INTO naps (name, kind, lat, lng, ports, parent_id, code, status, address, host, snmp_port, snmp_community,
        vendor, model, sys_name, firmware, last_probe_at, probe_error)
       VALUES (?, 'olt', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      name,
      lat,
      lng,
      ports,
      b.code ? String(b.code).trim() : null,
      status,
      b.address ? String(b.address).trim() : null,
      host,
      snmpPort,
      snmpCommunity,
      probe.vendor || (b.vendor ? String(b.vendor) : null),
      probe.model || (b.model ? String(b.model) : null),
      probe.sysName,
      probe.firmware,
      new Date().toISOString(),
      probe.error || null
    );

  const row = db.prepare(`${OLT_SELECT} AND id = ?`).get(info.lastInsertRowid) as any;
  res.status(201).json({ ...row, online: probe.online, live: true, probe });
});

app.put('/api/olts/:id', async (req, res) => {
  const id = Number(req.params.id);
  const ex = db.prepare("SELECT * FROM naps WHERE id = ? AND kind = 'olt'").get(id) as any;
  if (!ex) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const host = b.host !== undefined ? String(b.host || '').trim() : ex.host;
  const snmpPort = b.snmpPort != null ? Number(b.snmpPort) : ex.snmp_port || 161;
  const snmpCommunity =
    b.snmpCommunity !== undefined ? String(b.snmpCommunity || 'public').trim() : ex.snmp_community || 'public';

  let probe: Awaited<ReturnType<typeof probeOlt>> | null = null;
  let status = ex.status || 'offline';
  if (host) {
    probe = await probeOlt({ host, snmpPort, snmpCommunity });
    status = probe.online ? 'online' : 'offline';
  }

  db.prepare(
    `UPDATE naps SET name=?, lat=?, lng=?, ports=?, code=?, status=?, address=?, host=?, snmp_port=?, snmp_community=?,
      vendor=?, model=?, sys_name=?, firmware=?, last_probe_at=?, probe_error=? WHERE id=?`
  ).run(
    b.name != null ? String(b.name).trim() : ex.name,
    b.lat != null ? Number(b.lat) : ex.lat,
    b.lng != null ? Number(b.lng) : ex.lng,
    b.ports != null ? Number(b.ports) : ex.ports,
    b.code !== undefined ? (b.code ? String(b.code).trim() : null) : ex.code,
    status,
    b.address !== undefined ? (b.address ? String(b.address).trim() : null) : ex.address,
    host || null,
    snmpPort,
    snmpCommunity,
    probe?.vendor || (b.vendor !== undefined ? b.vendor || null : ex.vendor),
    probe?.model || (b.model !== undefined ? b.model || null : ex.model),
    probe?.sysName || ex.sys_name,
    probe?.firmware || ex.firmware,
    probe ? new Date().toISOString() : ex.last_probe_at,
    probe?.error || null,
    id
  );

  const row = db.prepare(`${OLT_SELECT} AND id = ?`).get(id) as any;
  res.json({ ...row, online: status === 'online', live: !!probe, probe });
});

app.delete('/api/olts/:id', (req, res) => {
  const id = Number(req.params.id);
  const ex = db.prepare("SELECT * FROM naps WHERE id = ? AND kind = 'olt'").get(id) as any;
  if (!ex) return res.status(404).json({ error: 'not found' });
  const children = (db.prepare('SELECT COUNT(*) AS c FROM naps WHERE parent_id = ?').get(id) as any).c;
  if (children > 0) return res.status(400).json({ error: 'Remove child NAPs first.' });
  db.prepare('DELETE FROM naps WHERE id = ?').run(id);
  db.prepare('DELETE FROM map_connectors WHERE kind = ? AND (from_id = ? OR to_id = ?)').run('server-olt', id, id);
  db.prepare('DELETE FROM map_connectors WHERE kind = ? AND (from_id = ? OR to_id = ?)').run('olt-nap', id, id);
  res.json({ ok: true });
});

// ---- NAPs (for the Add-User NAP/PLC selector) ----
app.get('/api/naps', (req, res) => {
  const all = req.query.all === '1';
  const where = all ? '' : "WHERE n.kind = 'nap'";
  const rows = db
    .prepare(
      `SELECT n.id, n.name, n.kind, n.ports, n.lat, n.lng, n.parent_id AS parentId,
              n.code, n.status, n.address, n.splitter_ratio AS splitterRatio, n.pon_port AS ponPort,
              (SELECT name FROM naps o WHERE o.id = n.parent_id) AS oltName,
              (SELECT kind FROM naps o WHERE o.id = n.parent_id) AS parentKind
       FROM naps n ${where} ORDER BY n.kind DESC, n.id`
    )
    .all();
  res.json(rows);
});

app.post('/api/naps', (req, res) => {
  const b = req.body || {};
  if (!b.name?.trim()) return res.status(400).json({ error: 'name is required' });
  const info = db
    .prepare(
      `INSERT INTO naps (name, kind, lat, lng, ports, parent_id, code, status, address, splitter_ratio, pon_port, host, snmp_port, snmp_community)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      String(b.name).trim(),
      b.kind || 'nap',
      b.lat != null ? Number(b.lat) : null,
      b.lng != null ? Number(b.lng) : null,
      Number(b.ports) || 8,
      b.parentId ? Number(b.parentId) : null,
      b.code ? String(b.code).trim() : null,
      b.status || 'active',
      b.address ? String(b.address).trim() : null,
      b.splitterRatio ? String(b.splitterRatio).trim() : null,
      b.ponPort != null && b.ponPort !== '' ? Number(b.ponPort) : null,
      b.host ? String(b.host).trim() : null,
      b.snmpPort != null ? Number(b.snmpPort) : 161,
      b.snmpCommunity ? String(b.snmpCommunity).trim() : 'public'
    );
  res.status(201).json(
    db
      .prepare(
        `SELECT id, name, kind, lat, lng, ports, parent_id AS parentId, code, status, address,
                splitter_ratio AS splitterRatio, pon_port AS ponPort, host, snmp_port AS snmpPort,
                snmp_community AS snmpCommunity, vendor, model, sys_name AS sysName, firmware,
                last_probe_at AS lastProbeAt, probe_error AS probeError FROM naps WHERE id = ?`
      )
      .get(info.lastInsertRowid)
  );
});

app.put('/api/naps/:id', (req, res) => {
  const id = Number(req.params.id);
  const ex = db.prepare('SELECT * FROM naps WHERE id = ?').get(id) as any;
  if (!ex) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  db.prepare(
    `UPDATE naps SET name=?, kind=?, lat=?, lng=?, ports=?, parent_id=?, code=?, status=?, address=?, splitter_ratio=?, pon_port=?,
      host=?, snmp_port=?, snmp_community=? WHERE id=?`
  ).run(
    b.name ?? ex.name,
    b.kind ?? ex.kind,
    b.lat != null ? Number(b.lat) : ex.lat,
    b.lng != null ? Number(b.lng) : ex.lng,
    b.ports != null ? Number(b.ports) : ex.ports,
    b.parentId !== undefined ? (b.parentId ? Number(b.parentId) : null) : ex.parent_id,
    b.code !== undefined ? (b.code ? String(b.code).trim() : null) : ex.code,
    b.status ?? ex.status ?? 'active',
    b.address !== undefined ? (b.address ? String(b.address).trim() : null) : ex.address,
    b.splitterRatio !== undefined
      ? b.splitterRatio
        ? String(b.splitterRatio).trim()
        : null
      : ex.splitter_ratio,
    b.ponPort !== undefined
      ? b.ponPort != null && b.ponPort !== ''
        ? Number(b.ponPort)
        : null
      : ex.pon_port,
    b.host !== undefined ? (b.host ? String(b.host).trim() : null) : ex.host,
    b.snmpPort != null ? Number(b.snmpPort) : ex.snmp_port ?? 161,
    b.snmpCommunity !== undefined ? String(b.snmpCommunity || 'public').trim() : ex.snmp_community ?? 'public',
    id
  );
  res.json(
    db
      .prepare(
        `SELECT id, name, kind, lat, lng, ports, parent_id AS parentId, code, status, address,
                splitter_ratio AS splitterRatio, pon_port AS ponPort, host, snmp_port AS snmpPort,
                snmp_community AS snmpCommunity, vendor, model, sys_name AS sysName, firmware,
                last_probe_at AS lastProbeAt, probe_error AS probeError FROM naps WHERE id = ?`
      )
      .get(id)
  );
});

app.delete('/api/naps/:id', (req, res) => {
  const id = Number(req.params.id);
  const used = (db.prepare('SELECT COUNT(*) AS c FROM pppoe_users WHERE nap_id = ?').get(id) as any).c;
  if (used > 0) return res.status(400).json({ error: 'NAP is assigned to clients. Reassign them first.' });
  const children = (db.prepare('SELECT COUNT(*) AS c FROM naps WHERE parent_id = ?').get(id) as any).c;
  if (children > 0) return res.status(400).json({ error: 'Remove child NAPs first.' });
  db.prepare('DELETE FROM naps WHERE id = ?').run(id);
  db.prepare(
    `DELETE FROM map_connectors WHERE
      (kind IN ('olt-nap','nap-nap','nap-client') AND (from_id = ? OR to_id = ?))`
  ).run(id, id);
  res.json({ ok: true });
});

/** Update map location / display fields for a server (router) without probing API. */
app.put('/api/map/servers/:id', (req, res) => {
  const id = Number(req.params.id);
  const ex = db.prepare('SELECT * FROM routers WHERE id = ?').get(id) as any;
  if (!ex) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  db.prepare('UPDATE routers SET name=?, status=?, lat=?, lng=?, address=? WHERE id=?').run(
    b.name != null ? String(b.name).trim() : ex.name,
    b.status != null ? String(b.status) : ex.status,
    b.lat != null && b.lat !== '' ? Number(b.lat) : ex.lat,
    b.lng != null && b.lng !== '' ? Number(b.lng) : ex.lng,
    b.address !== undefined ? (b.address ? String(b.address).trim() : null) : ex.address,
    id
  );
  res.json(db.prepare('SELECT id, name, host, status, lat, lng, address FROM routers WHERE id = ?').get(id));
});

// ---- Map cable connectors (editable street paths) ----
app.get('/api/map/connectors', (_req, res) => {
  const rows = db.prepare('SELECT id, kind, from_id AS fromId, to_id AS toId, points FROM map_connectors').all() as any[];
  res.json(rows.map((r) => ({ ...r, points: JSON.parse(r.points || '[]') })));
});

app.post('/api/map/connectors', (req, res) => {
  const b = req.body || {};
  const kind = String(b.kind || '');
  const fromId = Number(b.fromId);
  const toId = Number(b.toId);
  const points = b.points;
  const allowed = new Set(['server-olt', 'olt-nap', 'nap-nap', 'nap-client']);
  if (!allowed.has(kind) || !fromId || !toId || !Array.isArray(points) || points.length < 2) {
    return res.status(400).json({
      error: 'kind (server-olt|olt-nap|nap-nap|nap-client), fromId, toId, and points (min 2) are required',
    });
  }
  // One street path per topology pair — UNIQUE(kind, from_id, to_id) upsert below.
  const json = JSON.stringify(points);
  const ex = db.prepare('SELECT id FROM map_connectors WHERE kind = ? AND from_id = ? AND to_id = ?').get(kind, fromId, toId) as any;
  if (ex) {
    db.prepare('UPDATE map_connectors SET points = ? WHERE id = ?').run(json, ex.id);
    return res.json({ ok: true, id: ex.id });
  }
  const info = db.prepare('INSERT INTO map_connectors (kind, from_id, to_id, points) VALUES (?, ?, ?, ?)').run(kind, fromId, toId, json);
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

app.delete('/api/map/connectors', (req, res) => {
  const kind = String(req.query.kind || '');
  const fromId = Number(req.query.fromId);
  const toId = Number(req.query.toId);
  if (!kind || !fromId || !toId) return res.status(400).json({ error: 'kind, fromId, toId required' });
  db.prepare('DELETE FROM map_connectors WHERE kind = ? AND from_id = ? AND to_id = ?').run(kind, fromId, toId);
  res.json({ ok: true });
});

// ---- MikroTik file manager ----
app.get('/api/files', async (req, res) => {
  const routerId = Number(req.query.routerId);
  const router = getRouter(routerId);
  if (!router) return res.status(400).json({ error: 'Router not found' });
  try {
    const files = await listRouterFiles(router);
    res.json({ router: router.name, live: true, files });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || 'Could not list files from router' });
  }
});

app.delete('/api/files', async (req, res) => {
  const routerId = Number(req.query.routerId);
  const name = String(req.query.name || '');
  const router = getRouter(routerId);
  if (!router || !name) return res.status(400).json({ error: 'routerId and name are required' });
  try {
    await withRouter(router, (api) => api.write('/file/remove', [`=numbers=${name}`]));
    res.json({ ok: true });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || 'Could not delete file' });
  }
});

app.post('/api/files/upload', async (req, res) => {
  const routerId = Number(req.body?.routerId);
  const name = String(req.body?.name || '').trim();
  const content = req.body?.content;
  const router = getRouter(routerId);
  if (!router || !name) return res.status(400).json({ error: 'routerId and name are required' });
  if (content == null) return res.status(400).json({ error: 'content is required' });
  const text = typeof content === 'string' ? content : Buffer.from(content, 'base64').toString('utf8');
  if (text.length > 64000) return res.status(400).json({ error: 'File too large (max 64KB via API)' });
  try {
    await withRouter(router, async (api) => {
      const existing = (await api.write('/file/print', [`?name=${name}`])) as any[];
      if (!existing?.length) {
        await api.write('/file/add', [`=name=${name}`]);
      }
      await api.write('/file/set', [`=name=${name}`, `=contents=${text}`]);
    });
    res.json({ ok: true, name });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || 'Could not upload file' });
  }
});

// ---- Geocoding proxy (OpenStreetMap Nominatim) ----
app.get('/api/geocode', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q)}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'MT-Billing/1.0 (panel geocoder)' } });
    const data = (await r.json()) as any[];
    res.json(
      data.map((d) => ({ displayName: d.display_name, lat: Number(d.lat), lon: Number(d.lon) }))
    );
  } catch {
    res.status(502).json({ error: 'geocoding unavailable' });
  }
});

// ---- Inventory ----
app.get('/api/inventory', (_req, res) => {
  res.json(db.prepare('SELECT id, name, category, sku, quantity, unit_price AS unitPrice, status FROM inventory').all());
});

// ---- Logs ----
app.get('/api/logs', (_req, res) => {
  res.json(db.prepare('SELECT id, level, source, message, created_at AS date FROM logs ORDER BY id DESC LIMIT 200').all());
});

// ---- Company ----
app.get('/api/company', (_req, res) => {
  res.json(db.prepare('SELECT * FROM company WHERE id = 1').get());
});
app.put('/api/company', (req, res) => {
  const b = req.body || {};
  const c = db.prepare('SELECT * FROM company WHERE id = 1').get() as any;
  db.prepare(
    `UPDATE company SET name = ?, address = ?, phone = ?, email = ?, currency = ?, logo = ?,
       payment_qr = ?, gcash_qr = ?, maya_qr = ?, gcash_number = ?, maya_number = ?, payment_instructions = ?
     WHERE id = 1`
  ).run(
    b.name ?? c.name,
    b.address ?? c.address,
    b.phone ?? c.phone,
    b.email ?? c.email,
    b.currency ?? c.currency,
    b.logo !== undefined ? b.logo : c.logo,
    b.payment_qr !== undefined ? b.payment_qr : c.payment_qr,
    b.gcash_qr !== undefined ? b.gcash_qr : c.gcash_qr,
    b.maya_qr !== undefined ? b.maya_qr : c.maya_qr,
    b.gcash_number !== undefined ? b.gcash_number : c.gcash_number,
    b.maya_number !== undefined ? b.maya_number : c.maya_number,
    b.payment_instructions !== undefined ? b.payment_instructions : c.payment_instructions
  );
  res.json(db.prepare('SELECT * FROM company WHERE id = 1').get());
});

// ---- Hotspot (sample vouchers) ----
app.get('/api/hotspot', (_req, res) => {
  const plans = [
    { name: '1 Hour', price: 5, validity: '1h', speed: '5M/5M' },
    { name: '1 Day', price: 20, validity: '1d', speed: '10M/10M' },
    { name: '1 Week', price: 100, validity: '7d', speed: '10M/10M' },
    { name: '30 Days', price: 350, validity: '30d', speed: '15M/15M' },
  ];
  const active = Array.from({ length: 8 }, (_, i) => ({
    voucher: `HS-${(1000 + i * 137).toString().padStart(4, '0')}`,
    plan: plans[i % plans.length].name,
    address: `10.5.50.${i + 2}`,
    uptime: `${(i % 3) + 1}h${(i * 11) % 60}m`,
  }));
  res.json({ plans, active });
});

// ---- Uptime monitoring (global / Asia regional / PH local) ----
app.get('/api/uptime/scopes', (_req, res) => {
  res.json({ scopes: getUptimeScopes(), active: getActiveScope() });
});

app.get('/api/uptime', (req, res) => {
  const scope = setActiveScope(String(req.query.scope || getActiveScope())) as UptimeScope;
  const routerId = parseRouterId(req.query.routerId);
  setActiveRouterId(routerId);
  const router = routerId ? getRouter(routerId) : null;
  res.json({
    summary: getUptimeSummary(scope, routerId),
    monitors: getUptime(scope, routerId),
    scopes: getUptimeScopes(),
    routerId,
    routerName: router?.name ?? null,
  });
});

app.post('/api/uptime/check', async (req, res) => {
  const scope = setActiveScope(String(req.body?.scope || req.query.scope || getActiveScope())) as UptimeScope;
  const routerId = parseRouterId(req.body?.routerId ?? req.query.routerId);
  setActiveRouterId(routerId);
  const conn = scope === 'local' ? routerConnForId(routerId) : null;
  await runUptimeChecks(scope, conn, routerId);
  const router = routerId ? getRouter(routerId) : null;
  res.json({
    summary: getUptimeSummary(scope, routerId),
    monitors: getUptime(scope, routerId),
    scopes: getUptimeScopes(),
    routerId,
    routerName: router?.name ?? null,
  });
});

// ---- Status Hub (Uptime-Kuma style + uplink probes) ----
app.get('/api/status-hub', (req, res) => {
  const routerId = parseRouterId(req.query.routerId);
  setStatusHubRouterId(routerId);
  const router = routerId ? getRouter(routerId) : null;
  res.json({ ...listStatusOverview(routerId), routerId, routerName: router?.name ?? null });
});

app.get('/api/status-hub/uplink', (req, res) => {
  const routerId = parseRouterId(req.query.routerId);
  setStatusHubRouterId(routerId);
  const router = routerId ? getRouter(routerId) : null;
  res.json({ ...listUplinkOverview(routerId), routerId, routerName: router?.name ?? null });
});

app.get('/api/status-hub/check', async (req, res) => {
  try {
    const routerId = parseRouterId(req.query.routerId);
    setStatusHubRouterId(routerId);
    const conn = routerConnForId(routerId);
    const wait = String(req.query.wait || '') === '1';
    if (wait) {
      await runStatusChecks(undefined, conn, routerId);
      const router = routerId ? getRouter(routerId) : null;
      return res.json({ ...listStatusOverview(routerId), routerId, routerName: router?.name ?? null });
    }
    void runStatusChecks(undefined, conn, routerId).catch(() => undefined);
    const overview = listStatusOverview(routerId);
    const router = routerId ? getRouter(routerId) : null;
    res.json({
      ...overview,
      routerId,
      routerName: router?.name ?? null,
      summary: { ...overview.summary, scanning: true },
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Check failed' });
  }
});

app.get('/api/status-hub/uplink/check', async (req, res) => {
  try {
    const routerId = parseRouterId(req.query.routerId);
    setStatusHubRouterId(routerId);
    const conn = routerConnForId(routerId);
    const wait = String(req.query.wait || '') === '1';
    if (wait) {
      await runUplinkChecks(conn, routerId);
      const router = routerId ? getRouter(routerId) : null;
      return res.json({ ...listUplinkOverview(routerId), routerId, routerName: router?.name ?? null });
    }
    void runUplinkChecks(conn, routerId).catch(() => undefined);
    const overview = listUplinkOverview(routerId);
    const router = routerId ? getRouter(routerId) : null;
    res.json({
      ...overview,
      routerId,
      routerName: router?.name ?? null,
      summary: { ...overview.summary, scanning: true },
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Uplink check failed' });
  }
});

app.post('/api/status-hub/monitors', (req, res) => {
  try {
    const row = createMonitor(req.body || {});
    res.status(201).json(row);
  } catch (e: any) {
    res.status(400).json({ error: e?.message || 'Could not create monitor' });
  }
});

app.patch('/api/status-hub/monitors/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (typeof req.body?.enabled === 'boolean') setMonitorEnabled(id, req.body.enabled);
    else return res.status(400).json({ error: 'Nothing to update' });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ error: e?.message || 'Update failed' });
  }
});

app.delete('/api/status-hub/monitors/:id', (req, res) => {
  try {
    deleteMonitor(Number(req.params.id));
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ error: e?.message || 'Delete failed' });
  }
});

app.post('/api/status-hub/uplink/hosts', (req, res) => {
  try {
    const row = createUplinkHost(req.body || {});
    res.status(201).json(row);
  } catch (e: any) {
    res.status(400).json({ error: e?.message || 'Could not add host' });
  }
});

app.delete('/api/status-hub/uplink/hosts/:id', (req, res) => {
  try {
    deleteUplinkHost(Number(req.params.id));
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ error: e?.message || 'Delete failed' });
  }
});

// ---- Outage Monitor (Downdetector-style crowdsourced directory) ----
app.get('/api/outage-monitor', (_req, res) => {
  res.json(listOutageOverview());
});

app.get('/api/outage-monitor/check', async (_req, res) => {
  try {
    await runOutageSweep();
    res.json(listOutageOverview());
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Outage sweep failed' });
  }
});

app.get('/api/outage-monitor/:slug', (req, res) => {
  const row = getOutageService(String(req.params.slug || ''));
  if (!row) return res.status(404).json({ error: 'Service not found' });
  res.json(row);
});

app.get('/api/status-hub/metrics', (_req, res) => {
  res.type('text/plain; version=0.0.4; charset=utf-8').send(prometheusMetrics());
});

// ---- Live interface traffic (dashboard graphs) ----
app.get('/api/interfaces', async (req, res) => {
  const routerId = req.query.routerId ? Number(req.query.routerId) : null;
  if (routerId) {
    const router = getRouter(routerId);
    if (router?.host && router?.api_user) {
      try {
        const names = await fetchRouterInterfaceNames(router);
        return res.json({ names, source: 'router', routerId });
      } catch {
        return res.json({ names: [], source: 'router', routerId, error: 'unreachable' });
      }
    }
    return res.json({ names: [], source: 'router', routerId, error: 'not-configured' });
  }
  res.json({ names: getInterfaceNames(), source: 'panel' });
});

app.get('/api/interfaces/traffic', async (req, res) => {
  const routerId = req.query.routerId ? Number(req.query.routerId) : null;
  const ifaces = String(req.query.ifaces || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (routerId) {
    const router = getRouter(routerId);
    if (router?.host && router?.api_user) {
      try {
        const names = ifaces.length ? ifaces : await fetchRouterInterfaceNames(router);
        const sample = names.slice(0, 12);
        const interfaces = await fetchRouterInterfaceTraffic(router, sample);
        return res.json({ t: Date.now(), interfaces, source: 'router', routerId });
      } catch {
        return res.json({ t: Date.now(), interfaces: [], source: 'router', routerId, error: 'unreachable' });
      }
    }
    return res.json({ t: Date.now(), interfaces: [], source: 'router', routerId, error: 'not-configured' });
  }

  res.json({ ...getTrafficSnapshot(), source: 'panel' });
});

// ---- Email/SMS notifications & reminders ----
app.get('/api/clients', (_req, res) => {
  res.json(
    db
      .prepare('SELECT id, username, customer_name AS customer, email, contact, service, status FROM pppoe_users ORDER BY customer_name')
      .all()
  );
});

app.get('/api/notifications', (_req, res) => {
  res.json(listNotifications());
});

app.get('/api/notifications/settings', (_req, res) => {
  res.json(getNotifySettings());
});

app.put('/api/notifications/settings', (req, res) => {
  res.json(updateNotifySettings(req.body || {}));
});

// Manual send to all clients (email/sms/both) or a single client.
app.post('/api/notifications/send', async (req, res) => {
  const b = req.body || {};
  if (!b.message) return res.status(400).json({ error: 'message is required' });
  const target = b.target === 'client' ? 'client' : b.target === 'selected' ? 'selected' : 'all';
  const result = await sendManual({
    channel: b.channel || 'email',
    target,
    clientId: b.clientId ? Number(b.clientId) : undefined,
    clientIds: Array.isArray(b.clientIds) ? b.clientIds.map((x: any) => Number(x)) : undefined,
    subject: b.subject,
    message: b.message,
  });
  res.json(result);
});

// Run the reminder + auto-disable automations immediately (also runs on a timer).
app.post('/api/notifications/run', async (_req, res) => {
  const summary = await runAutomations();
  res.json(summary);
});

// Preview / execute overdue + past-grace expiry protocols (PPPoE / PPP IPoE users).
app.get('/api/pppoe/billing-recheck', (req, res) => {
  const service = req.query.service ? String(req.query.service) : undefined;
  res.json(previewBillingEnforcement({ service }));
});

app.post('/api/pppoe/billing-recheck', async (req, res) => {
  const service = req.body?.service || req.query.service ? String(req.body?.service || req.query.service) : undefined;
  const preview = previewBillingEnforcement({ service });
  if (!preview.toExpire.length && !preview.toDisable.length) {
    return res.json({
      ok: true,
      message: 'No overdue or past-grace accounts found.',
      ...preview,
      result: null,
    });
  }
  const result = await executeBillingEnforcement({ service, forceDisable: true });
  res.json({
    ok: true,
    message: `Applied expiry to ${result.markedNonPayment} account(s); disabled ${result.disabled} past grace.`,
    preview,
    result,
  });
});

// IPoE DHCP lease overdue / past-grace recheck (block on MikroTik after grace).
app.get('/api/ipoe/billing-recheck', async (req, res) => {
  const routerId = req.query.routerId ? Number(req.query.routerId) : null;
  res.json(await previewIpoeBillingEnforcement(routerId));
});

app.post('/api/ipoe/billing-recheck', async (req, res) => {
  const routerId = Number(req.body?.routerId || req.query.routerId || 0) || null;
  const preview = await previewIpoeBillingEnforcement(routerId);
  if (!preview.toExpire.length && !preview.toDisable.length) {
    return res.json({
      ok: true,
      message: 'No overdue or past-grace IPoE leases found.',
      ...preview,
      result: null,
    });
  }
  const result = await executeIpoeBillingEnforcement(routerId);
  res.json({
    ok: true,
    message: `Marked ${result.markedNonPayment} lease(s) non-payment; blocked ${result.blocked} past grace.`,
    preview,
    result,
  });
});

app.use('/api', settingsRouter);
app.use('/api', aiRouter);
app.use('/api', terminalRouter);
app.use('/api', extraRouter);

const server = http.createServer(app);
initTerminalWs(server);

process.on('mt-billing-restart' as any, () => {
  console.log('MT-Billing API restarting…');
  try {
    server.close(() => process.exit(1));
  } catch {
    process.exit(1);
  }
  setTimeout(() => process.exit(1), 2500);
});

server.listen(PORT, () => {
  console.log(`MT-Billing API listening on http://localhost:${PORT}`);
  startUptime(90000);
  startStatusHub(5 * 60_000);
  startOutageMonitor(3 * 60_000);
  startNotifyScheduler(5 * 60 * 1000);
  startUsageScheduler(60_000);
});
