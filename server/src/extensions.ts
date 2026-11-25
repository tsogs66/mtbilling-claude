/**
 * Service-extension policy. One place owns the numbers so the portal request
 * path, the staff decision path and the overdue enforcement all agree.
 *
 * Rule: an extension request is approved automatically, adds EXTENSION_DAYS,
 * and is allowed EXTENSION_MAX_USES times. The counter starts over when the
 * subscriber pays (a `payment` transaction newer than the last extension), so
 * the allowance is per unpaid stretch rather than for the life of the account.
 * When all uses are spent and the due date passes again, the account goes
 * non-payment and is disabled with no further grace.
 */
import { db } from './db.js';

export const EXTENSION_DAYS = 3;
export const EXTENSION_MAX_USES = 3;

/**
 * Extensions granted since the subscriber last paid.
 *
 * Throws when the table is unreadable. Callers that GRANT must treat that as
 * "no more extensions"; callers that DISABLE must treat it as "do not disable".
 */
export function extensionsUsed(pppoeUserId: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM portal_extension_requests r
       WHERE r.pppoe_user_id = ?
         AND r.status = 'accepted'
         AND julianday(COALESCE(r.reviewed_at, r.created_at)) > COALESCE((
           SELECT MAX(julianday(t.created_at))
           FROM transactions t
           WHERE t.pppoe_user_id = ? AND t.type = 'payment' AND t.amount > 0
         ), 0)`
    )
    .get(pppoeUserId, pppoeUserId) as { n: number } | undefined;
  return Number(row?.n) || 0;
}

export function extensionsRemaining(pppoeUserId: number): number {
  return Math.max(0, EXTENSION_MAX_USES - extensionsUsed(pppoeUserId));
}

/** True when every allowed extension has been used since the last payment. */
export function extensionsExhausted(pppoeUserId: number): boolean {
  return extensionsUsed(pppoeUserId) >= EXTENSION_MAX_USES;
}
