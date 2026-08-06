import { db } from './db.js';
import { publishPortalEvent, type PortalLiveEvent } from './portalEvents.js';
import { listRecentSubscriberOutageReports } from './outageMonitor.js';

export type StaffNotificationType =
  | 'plan_change'
  | 'ticket'
  | 'outage_report'
  | 'payment_link_created'
  | 'payment_submitted'
  | 'payment_paymongo_merchant';

export type StaffNotificationRow = {
  id: number;
  type: StaffNotificationType;
  title: string;
  body: string | null;
  entityType: string | null;
  entityId: number | null;
  pppoeUserId: number | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
  read: boolean;
  href: string | null;
};

function columnExists(table: string, col: string): boolean {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return rows.some((r) => r.name === col);
  } catch {
    return false;
  }
}

export function initStaffNotifications() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS staff_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      entity_type TEXT,
      entity_id INTEGER,
      pppoe_user_id INTEGER,
      payload TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_staff_notifications_created
      ON staff_notifications(created_at DESC);

    CREATE TABLE IF NOT EXISTS staff_notification_reads (
      notification_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      read_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (notification_id, user_id)
    );
  `);

  if (!columnExists('job_orders', 'source')) {
    try {
      db.exec(`ALTER TABLE job_orders ADD COLUMN source TEXT DEFAULT 'admin'`);
    } catch {
      /* ignore */
    }
  }
}

function hrefFor(type: StaffNotificationType, entityId?: number | null): string | null {
  switch (type) {
    case 'plan_change':
      return '/subscriber-portal?tab=plans';
    case 'ticket':
      return entityId ? `/job-orders?highlight=${entityId}` : '/job-orders';
    case 'outage_report':
      return entityId ? `/outage-monitor?report=${entityId}` : '/outage-monitor';
    case 'payment_link_created':
    case 'payment_submitted':
    case 'payment_paymongo_merchant':
      return entityId ? `/pay-portal?highlight=${entityId}` : '/pay-portal';
    default:
      return null;
  }
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

/** Persist a staff inbox row and broadcast on the portal SSE hub for live topbar updates. */
export function notifyStaff(opts: {
  type: StaffNotificationType;
  title: string;
  body?: string | null;
  entityType?: string | null;
  entityId?: number | null;
  pppoeUserId?: number | null;
  payload?: Record<string, unknown> | null;
  action?: PortalLiveEvent['action'];
  status?: string | null;
}) {
  const info = db
    .prepare(
      `INSERT INTO staff_notifications
         (type, title, body, entity_type, entity_id, pppoe_user_id, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      opts.type,
      opts.title,
      opts.body || null,
      opts.entityType || null,
      opts.entityId ?? null,
      opts.pppoeUserId ?? null,
      opts.payload ? JSON.stringify(opts.payload) : null
    );
  const id = Number(info.lastInsertRowid);
  const href = hrefFor(opts.type, opts.entityId);
  publishPortalEvent({
    type: opts.type,
    action: opts.action || 'created',
    pppoeUserId: opts.pppoeUserId,
    requestId: opts.entityId,
    status: opts.status,
    payload: {
      notificationId: id,
      title: opts.title,
      body: opts.body || null,
      href,
      ...(opts.payload || {}),
    },
  });
  return id;
}

/** Ensure Outage Monitor received reports appear in the staff inbox. */
function ensureOutageReportNotifications() {
  try {
    const reports = listRecentSubscriberOutageReports(40);
    if (!reports.length) return;
    const existing = db
      .prepare(
        `SELECT type, entity_type AS entityType, entity_id AS entityId, payload FROM staff_notifications
         WHERE type = 'outage_report'
            OR title = 'Service outage report'`
      )
      .all() as {
      type: string;
      entityType: string | null;
      entityId: number | null;
      payload: string | null;
    }[];
    const known = new Set<number>();
    const knownJobOrders = new Set<number>();
    for (const row of existing) {
      const payload = parsePayload(row.payload);
      const rid = payload?.outageReportId != null ? Number(payload.outageReportId) : null;
      if (rid && Number.isFinite(rid)) known.add(rid);
      if (
        row.entityId != null &&
        (row.type === 'outage_report' || row.entityType === 'outage_subscriber_report')
      ) {
        known.add(Number(row.entityId));
      }
      const jid = payload?.jobOrderId != null ? Number(payload.jobOrderId) : null;
      if (jid && Number.isFinite(jid)) knownJobOrders.add(jid);
      // Legacy ticket rows used job_order id as entity_id
      if (row.entityId != null && (row.type === 'ticket' || row.entityType === 'job_order')) {
        knownJobOrders.add(Number(row.entityId));
      }
    }
    const ins = db.prepare(
      `INSERT INTO staff_notifications
         (type, title, body, entity_type, entity_id, pppoe_user_id, payload, created_at)
       VALUES ('outage_report', ?, ?, 'outage_subscriber_report', ?, ?, ?, ?)`
    );
    for (const r of reports) {
      if (known.has(Number(r.id))) continue;
      if (r.jobOrderId != null && knownJobOrders.has(Number(r.jobOrderId))) continue;
      const who =
        String(r.customerName || '').trim() ||
        String(r.accountNumber || '').trim() ||
        'Subscriber';
      const names = (r.services || []).map((s) => s.name).filter(Boolean);
      const body = `${who} reported outage on ${names.join(', ') || 'selected services'}.${
        r.description ? ` ${String(r.description).slice(0, 120)}` : ''
      }`;
      ins.run(
        'Service outage report',
        body,
        Number(r.id),
        r.pppoeUserId ?? null,
        JSON.stringify({
          outageReportId: Number(r.id),
          jobOrderId: r.jobOrderId ?? null,
          serviceNames: names,
          description: r.description || null,
        }),
        r.createdAt || null
      );
      known.add(Number(r.id));
    }
  } catch {
    /* table may not exist yet during early boot */
  }
}

export function listStaffNotifications(userId: number, limit = 40) {
  ensureOutageReportNotifications();
  const lim = Math.min(100, Math.max(1, Math.floor(limit) || 40));
  const rows = db
    .prepare(
      `SELECT n.id, n.type, n.title, n.body, n.entity_type AS entityType, n.entity_id AS entityId,
              n.pppoe_user_id AS pppoeUserId, n.payload, n.created_at AS createdAt,
              CASE WHEN r.notification_id IS NULL THEN 0 ELSE 1 END AS isRead
       FROM staff_notifications n
       LEFT JOIN staff_notification_reads r
         ON r.notification_id = n.id AND r.user_id = ?
       ORDER BY n.id DESC
       LIMIT ?`
    )
    .all(userId, lim) as any[];

  const unreadRow = db
    .prepare(
      `SELECT COUNT(*) AS c
       FROM staff_notifications n
       LEFT JOIN staff_notification_reads r
         ON r.notification_id = n.id AND r.user_id = ?
       WHERE r.notification_id IS NULL`
    )
    .get(userId) as { c: number };

  const items: StaffNotificationRow[] = rows.map((r) => {
    let type = r.type as StaffNotificationType;
    let entityId = r.entityId != null ? Number(r.entityId) : null;
    const payload = parsePayload(r.payload);
    // Legacy portal outage filings were stored as tickets — surface them as outage reports.
    if (
      type === 'ticket' &&
      (String(r.title || '') === 'Service outage report' ||
        (Array.isArray(payload?.serviceNames) && (payload!.serviceNames as unknown[]).length > 0))
    ) {
      type = 'outage_report';
      const reportId = payload?.outageReportId != null ? Number(payload.outageReportId) : null;
      if (reportId && Number.isFinite(reportId)) entityId = reportId;
      else entityId = null; // open Outage Monitor list
    }
    return {
      id: Number(r.id),
      type,
      title: String(r.title || ''),
      body: r.body != null ? String(r.body) : null,
      entityType: r.entityType != null ? String(r.entityType) : null,
      entityId,
      pppoeUserId: r.pppoeUserId != null ? Number(r.pppoeUserId) : null,
      payload,
      createdAt: String(r.createdAt || ''),
      read: Number(r.isRead) === 1,
      href: hrefFor(type, entityId),
    };
  });

  return { items, unreadCount: Number(unreadRow?.c) || 0 };
}

export function markStaffNotificationsRead(userId: number, opts: { ids?: number[]; all?: boolean }) {
  if (opts.all) {
    db.prepare(
      `INSERT OR IGNORE INTO staff_notification_reads (notification_id, user_id)
       SELECT id, ? FROM staff_notifications`
    ).run(userId);
    return { ok: true, unreadCount: 0 };
  }
  const ids = (opts.ids || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  const ins = db.prepare(
    `INSERT OR IGNORE INTO staff_notification_reads (notification_id, user_id) VALUES (?, ?)`
  );
  const tx = db.transaction((list: number[]) => {
    for (const id of list) ins.run(id, userId);
  });
  tx(ids);
  const unreadRow = db
    .prepare(
      `SELECT COUNT(*) AS c
       FROM staff_notifications n
       LEFT JOIN staff_notification_reads r
         ON r.notification_id = n.id AND r.user_id = ?
       WHERE r.notification_id IS NULL`
    )
    .get(userId) as { c: number };
  return { ok: true, unreadCount: Number(unreadRow?.c) || 0 };
}

/** Best-effort subscriber label for notification copy. */
export function subscriberLabel(pppoeUserId: number | null | undefined): string {
  if (!pppoeUserId) return 'Subscriber';
  const u = db
    .prepare(
      `SELECT customer_name, account_number, username FROM pppoe_users WHERE id = ?`
    )
    .get(pppoeUserId) as any;
  if (!u) return 'Subscriber';
  return (
    String(u.customer_name || '').trim() ||
    String(u.account_number || '').trim() ||
    String(u.username || '').trim() ||
    'Subscriber'
  );
}
