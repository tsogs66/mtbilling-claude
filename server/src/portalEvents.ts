import { EventEmitter } from 'events';
import type { Response } from 'express';

export type PortalLiveEvent = {
  type:
    | 'plan_change'
    | 'ticket'
    | 'ping'
    | 'payment_link_created'
    | 'payment_submitted'
    | 'outage_notice'
    | 'portal_activity'
    | 'addon_request'
    | 'reconnect_request'
    | 'contact_updated'
    | 'referral'
    | 'payment';
  action?: 'created' | 'accepted' | 'rejected' | 'updated' | 'cancelled';
  /** PPPoE user id — portal clients filter to themselves; staff see all. */
  pppoeUserId?: number | null;
  requestId?: number | null;
  entityType?: string | null;
  entityId?: number | null;
  title?: string | null;
  body?: string | null;
  status?: string | null;
  at?: string;
  payload?: Record<string, unknown>;
};

const hub = new EventEmitter();
hub.setMaxListeners(200);

export function publishPortalEvent(event: PortalLiveEvent) {
  const msg: PortalLiveEvent = {
    ...event,
    at: event.at || new Date().toISOString(),
  };
  hub.emit('portal', msg);
}

export function subscribePortalEvents(
  listener: (event: PortalLiveEvent) => void,
  filter?: { pppoeUserId?: number }
) {
  const wrapped = (event: PortalLiveEvent) => {
    if (filter?.pppoeUserId != null && event.pppoeUserId != null && event.pppoeUserId !== filter.pppoeUserId) {
      return;
    }
    listener(event);
  };
  hub.on('portal', wrapped);
  return () => hub.off('portal', wrapped);
}

/** Open an SSE response and forward portal events until the client disconnects. */
export function pipePortalSse(
  res: Response,
  filter?: { pppoeUserId?: number }
) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  try {
    (res as any).socket?.setTimeout?.(0);
    (res as any).socket?.setNoDelay?.(true);
  } catch {
    /* ignore */
  }
  if (typeof (res as any).flushHeaders === 'function') (res as any).flushHeaders();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('hello', { ok: true, t: Date.now() });

  const onEvent = (event: PortalLiveEvent) => {
    send(event.type, event);
  };
  const unsub = subscribePortalEvents(onEvent, filter);
  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      /* closed */
    }
  }, 20_000);

  const cleanup = () => {
    clearInterval(heartbeat);
    unsub();
  };

  res.on('close', cleanup);
  reqSafeOn(res, cleanup);
}

function reqSafeOn(res: Response, cleanup: () => void) {
  const req = (res as any).req;
  if (req && typeof req.on === 'function') {
    req.on('close', cleanup);
    req.on('aborted', cleanup);
  }
}
