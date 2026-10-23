import express from 'express';
import { db } from './db.js';
import {
  publicAcsConfig,
  saveAcsConfig,
  testAcsConnection,
  listAcsDevices,
  getAcsDevice,
  postAcsTask,
  refreshAcsDevice,
  rebootAcsDevice,
  setAcsParameterValues,
  flattenAcsParameters,
  ACS_PARAMETER_PRESETS,
  pickFirstParam,
  listSubscriberAcsLinks,
  linkSubscriberDevice,
  normalizeAcsDeviceId,
  acsDeviceIdsEquivalent,
} from './genieacs.js';
import { runAcsAutolink } from './acsAutolink.js';

export const acsRouter = express.Router();

function subscriberForAcsDevice(deviceId: string) {
  const links = listSubscriberAcsLinks() as {
    acs_device_id: string;
    id: number;
    username: string;
    customer_name: string;
    account_number: string;
  }[];
  const hit = links.find((l) => acsDeviceIdsEquivalent(l.acs_device_id, deviceId));
  return hit
    ? {
        id: hit.id,
        username: hit.username,
        customer_name: hit.customer_name,
        account_number: hit.account_number,
      }
    : undefined;
}

/** Express already URL-decodes query params once; do not decodeURIComponent again (%2D → -). */
function deviceIdFromClient(input: unknown): string {
  return String(input ?? '').trim();
}

async function buildAcsDeviceDetailPayload(deviceIdInput: string) {
  const deviceId = deviceIdFromClient(deviceIdInput);
  const doc = await getAcsDevice(deviceId);
  let params: ReturnType<typeof flattenAcsParameters> = [];
  let parametersTruncated = false;
  try {
    params = flattenAcsParameters(doc);
    parametersTruncated = params.length >= 12_000;
  } catch (flatErr: unknown) {
    console.error('[acs] flatten device', deviceId, flatErr);
  }
  const presets = ACS_PARAMETER_PRESETS.map((p) => ({
    ...p,
    current: pickFirstParam(params, p.paths),
  }));
  const sub = subscriberForAcsDevice(deviceId);
  const canonicalId =
    doc && typeof doc === 'object' && (doc as { _id?: string })._id != null
      ? String((doc as { _id: string })._id)
      : normalizeAcsDeviceId(deviceId);
  return {
    device: doc,
    deviceId: canonicalId,
    displayId: normalizeAcsDeviceId(canonicalId) || canonicalId,
    parameters: params,
    parametersTruncated,
    presets,
    subscriber: sub || null,
  };
}

acsRouter.get('/acs/config', (_req, res) => {
  res.json(publicAcsConfig());
});

acsRouter.put('/acs/config', (req, res) => {
  try {
    res.json(saveAcsConfig(req.body || {}));
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'save failed' });
  }
});

acsRouter.post('/acs/autolink', async (req, res) => {
  try {
    const dryRun = req.body?.dryRun === true || req.query.dryRun === '1';
    const subscriberId =
      req.body?.subscriberId != null
        ? Number(req.body.subscriberId)
        : req.query.subscriberId != null
          ? Number(req.query.subscriberId)
          : undefined;
    const syncTagsOnly = req.body?.syncTagsOnly === true;
    const result = await runAcsAutolink({
      dryRun,
      subscriberId: subscriberId && subscriberId > 0 ? subscriberId : undefined,
      syncTagsOnly,
    });
    res.json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'autolink failed';
    const status = msg === 'acs-disabled' || msg === 'acs-autolink-disabled' ? 503 : 502;
    res.status(status).json({ error: msg });
  }
});

acsRouter.post('/acs/test', async (_req, res) => {
  try {
    res.json(await testAcsConnection());
  } catch (e: unknown) {
    res.status(500).json({ ok: false, message: e instanceof Error ? e.message : 'test failed' });
  }
});

acsRouter.get('/acs/presets', (_req, res) => {
  res.json(ACS_PARAMETER_PRESETS);
});

acsRouter.get('/acs/links', (_req, res) => {
  res.json(listSubscriberAcsLinks());
});

acsRouter.put('/acs/link', (req, res) => {
  try {
    const pppoeUserId = Number(req.body?.pppoeUserId ?? req.body?.pppoe_user_id);
    if (!pppoeUserId) return res.status(400).json({ error: 'pppoeUserId required' });
    const deviceId = req.body?.deviceId ?? req.body?.device_id ?? null;
    res.json(linkSubscriberDevice(pppoeUserId, deviceId != null ? String(deviceId) : null));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'link failed';
    res.status(msg === 'subscriber-not-found' ? 404 : 500).json({ error: msg });
  }
});

acsRouter.get('/acs/devices', async (req, res) => {
  try {
    const query = req.query.query != null ? String(req.query.query) : undefined;
    const limit = req.query.limit != null ? Number(req.query.limit) : 200;
    const devices = await listAcsDevices({ query, limit });
    const links = listSubscriberAcsLinks() as { acs_device_id: string; id: number; customer_name: string; username: string }[];
    const enriched = (devices as Record<string, unknown>[]).map((d) => {
      const id = String(d._id || '');
      const sub = links.find((l) => acsDeviceIdsEquivalent(l.acs_device_id, id));
      return {
        id,
        displayId: normalizeAcsDeviceId(id) || id,
        lastInform: d._lastInform ?? null,
        tags: d._tags ?? [],
        subscriber: sub
          ? { id: sub.id, name: sub.customer_name, username: sub.username }
          : null,
      };
    });
    res.json(enriched);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'list failed';
    const status = msg === 'acs-disabled' ? 503 : 502;
    res.status(status).json({ error: msg });
  }
});

async function respondAcsDeviceDetail(req: express.Request, res: express.Response, deviceIdRaw: unknown) {
  const deviceId = deviceIdFromClient(deviceIdRaw);
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  try {
    res.json(await buildAcsDeviceDetailPayload(deviceId));
  } catch (e: unknown) {
    res.status(502).json({ error: e instanceof Error ? e.message : 'fetch failed' });
  }
}

acsRouter.get('/acs/devices/by-id', async (req, res) => {
  await respondAcsDeviceDetail(req, res, req.query.deviceId ?? req.query.id);
});

/** Prefer POST on mobile — avoids axios double-encoding `%2D` in query strings. */
acsRouter.post('/acs/devices/detail', async (req, res) => {
  await respondAcsDeviceDetail(req, res, req.body?.deviceId ?? req.body?.device_id);
});

acsRouter.get('/acs/devices/:deviceId', async (req, res) => {
  try {
    if (req.params.deviceId === 'by-id') return res.status(400).json({ error: 'use /acs/devices/by-id' });
    const deviceId = decodeURIComponent(req.params.deviceId);
    res.json(await buildAcsDeviceDetailPayload(deviceId));
  } catch (e: unknown) {
    res.status(502).json({ error: e instanceof Error ? e.message : 'fetch failed' });
  }
});

acsRouter.get('/acs/subscribers/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const safe = q.replace(/[%_]/g, '');
  if (!safe) return res.json([]);
  const like = `%${safe}%`;
  const rows = db
    .prepare(
      `SELECT id, username, customer_name, account_number, acs_device_id, status
       FROM pppoe_users
       WHERE customer_name LIKE ? COLLATE NOCASE
          OR username LIKE ? COLLATE NOCASE
          OR account_number LIKE ?
       ORDER BY customer_name
       LIMIT 30`
    )
    .all(like, like, like);
  res.json(rows);
});

acsRouter.post('/acs/devices/:deviceId/tasks', async (req, res) => {
  try {
    const deviceId = decodeURIComponent(req.params.deviceId);
    const connectionRequest = req.query.connection_request !== 'false';
    const out = await postAcsTask(deviceId, req.body || {}, connectionRequest);
    res.json(out);
  } catch (e: unknown) {
    res.status(502).json({ error: e instanceof Error ? e.message : 'task failed' });
  }
});

acsRouter.post('/acs/devices/:deviceId/refresh', async (req, res) => {
  try {
    const deviceId = decodeURIComponent(req.params.deviceId);
    const objectName = String(req.body?.objectName || 'InternetGatewayDevice.');
    res.json(await refreshAcsDevice(deviceId, objectName));
  } catch (e: unknown) {
    res.status(502).json({ error: e instanceof Error ? e.message : 'refresh failed' });
  }
});

acsRouter.post('/acs/devices/:deviceId/reboot', async (req, res) => {
  try {
    const deviceId = decodeURIComponent(req.params.deviceId);
    res.json(await rebootAcsDevice(deviceId));
  } catch (e: unknown) {
    res.status(502).json({ error: e instanceof Error ? e.message : 'reboot failed' });
  }
});

acsRouter.post('/acs/devices/:deviceId/set-parameter', async (req, res) => {
  try {
    const deviceId = decodeURIComponent(req.params.deviceId);
    const path = String(req.body?.path || '').trim();
    const value = req.body?.value != null ? String(req.body.value) : '';
    const type = String(req.body?.type || 'xsd:string');
    if (!path) return res.status(400).json({ error: 'path required' });
    const out = await setAcsParameterValues(deviceId, [[path, value, type]]);
    db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
      'info',
      'acs',
      `Set ${path} on ${deviceId} (subscriber CPE)`
    );
    res.json(out);
  } catch (e: unknown) {
    res.status(502).json({ error: e instanceof Error ? e.message : 'set failed' });
  }
});
