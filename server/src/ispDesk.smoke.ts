process.env.MT_DATA_DIR = '/tmp/isp-smoke-data';
process.env.JWT_SECRET = 'smoke-test-secret';

const { db, initSchema, migrate, seed } = await import('./db.js');
const { initExtra } = await import('./extra.js');
const { initIspOps } = await import('./ispOps.js');
const { initGenieacs } = await import('./genieacs.js');
const desk = await import('./ispDesk.js');

initSchema();
migrate();
seed();
initExtra();
initIspOps();
initGenieacs();
desk.initIspDesk();

const nap = db.prepare(`INSERT INTO naps (name, kind, ports) VALUES ('NAP-12', 'nap', 8)`).run();
const user = db
  .prepare(
    `INSERT INTO pppoe_users (username, password, customer_name, account_number, profile, status, subscription_due, price, nap_id, contact, service, online)
     VALUES ('juan', 'secret', 'Juan Dela Cruz', 'ACC1', 'UNLI50', 'Active', date('now', '-3 day'), 999, ?, '09171234567', 'pppoe', 0)`
  )
  .run(nap.lastInsertRowid);

const pay = desk.recordIspPayment({
  pppoeUserId: Number(user.lastInsertRowid),
  amount: 500,
  method: 'cash',
  cashier: 'maria',
  note: 'partial',
  extendMonths: 0,
}) as { or_number: string; id: number };
if (!String(pay.or_number).startsWith('OR-')) throw new Error('missing OR ' + JSON.stringify(pay));

const pay2 = desk.recordIspPayment({
  pppoeUserId: Number(user.lastInsertRowid),
  amount: 499,
  method: 'gcash',
  cashier: 'maria',
  extendMonths: 1,
}) as { or_number: string };
if (pay2.or_number === pay.or_number) throw new Error('OR numbers collided');

desk.reverseIspPayment(pay.id, 'wrong amount', 'maria');
const hub = desk.subscriberHub(Number(user.lastInsertRowid));
if (!hub?.user || hub.payments.length < 2) throw new Error('hub incomplete');
if ((hub.nap as { name?: string } | null)?.name !== 'NAP-12') throw new Error('nap missing on hub');
if ('password' in (hub.user as object) || 'portal_pin_hash' in (hub.user as object)) {
  throw new Error('hub leaked subscriber secrets');
}

desk.insertCgnat(
  desk.parseCgnatLine('2026-10-23T01:00:00Z 10.0.0.5:1234 203.0.113.8:54321 tcp juan')!,
  'raw'
);
db.prepare(
  `INSERT INTO session_history (pppoe_user_id, username, framed_ip, started_at) VALUES (?, 'juan', '10.0.0.5', '2026-10-23T00:00:00Z')`
).run(user.lastInsertRowid);
if (!desk.searchCgnat({ publicIp: '203.0.113.8', at: '2026-10-23T02:00:00Z' }).length) throw new Error('cgnat search missed');
if (!desk.searchSessions({ ip: '10.0.0.5', at: '2026-10-23T01:00:00Z' }).length) throw new Error('session search missed');

db.prepare(`INSERT INTO inventory (name, quantity) VALUES ('Drop cable', 5)`).run();
const inv = db.prepare(`SELECT id FROM inventory WHERE name = 'Drop cable'`).get() as { id: number };
const job = db
  .prepare(
    `INSERT INTO job_orders (number, pppoe_user_id, type, status, onu_serial, materials_json, stock_applied)
     VALUES ('JO-SMOKE', ?, 'new_install', 'completed', 'HWTC123', ?, 0)`
  )
  .run(user.lastInsertRowid, JSON.stringify([{ inventoryId: inv.id, qty: 2 }]));
desk.finalizeJobOrder(Number(job.lastInsertRowid), 'open');
const qty = db.prepare('SELECT quantity FROM inventory WHERE id = ?').get(inv.id) as { quantity: number };
if (qty.quantity !== 3) throw new Error('stock not deducted: ' + qty.quantity);
const onu = db.prepare('SELECT onu_serial, online FROM pppoe_users WHERE id = ?').get(user.lastInsertRowid) as {
  onu_serial: string;
  online: number;
};
if (onu.onu_serial !== 'HWTC123' || onu.online !== 1) throw new Error('onu not stored ' + JSON.stringify(onu));

const naps = desk.napDispatch() as { name: string; fill_count: number }[];
if (!naps.some((n) => n.name === 'NAP-12' && n.fill_count >= 1)) throw new Error('dispatch fill');
if (!desk.financeDesk().byCashier) throw new Error('finance missing');
const radius = desk.radiusExport();
if (!radius.includes('juan')) throw new Error('radius export missing user');
if (/Mikrotik-Group := "[^"]+",/.test(radius)) throw new Error('radius reply has a trailing comma');
if (!desk.publicAreaStatus().branch) throw new Error('public status missing branch');

let threw = false;
try {
  await desk.cpeAction(Number(user.lastInsertRowid), { action: 'reboot' });
} catch (e) {
  threw = e instanceof Error && e.message === 'cpe-not-linked';
}
if (!threw) throw new Error('cpe action should require a linked device');

console.log('isp smoke: ok');

export {};
