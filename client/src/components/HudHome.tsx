import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip, BarChart, Bar, XAxis, YAxis } from 'recharts';
import { api, peso } from '../api';

type Slice = { name: string; value: number; key: string };
type Person = { id: number; name: string; account: string; due?: string | null; price?: number; balance?: number };
type Late = { id: number; name: string; account: string; previousDue: string; paidOn: string; amount: number };
type Report = {
  total: number;
  active: number;
  online: number;
  offline: number;
  nonPayment: number;
  expired: number;
  disabled: number;
  target: number;
  collected: number;
  remaining: number;
  openBalance: number;
  paidCount: number;
  onTimeCount: number;
  lateCount: number;
  unpaidCount: number;
  coveredCount: number;
  pie: Slice[];
  unpaid: Person[];
  late: Late[];
};

const SLICE_COLOR: Record<string, string> = {
  online: '#10b981',
  offline: '#f59e0b',
  'non-payment': '#f97316',
  expired: '#f43f5e',
  disabled: '#64748b',
  active: '#38bdf8',
};

const NODES: { key: string; label: string; view: string }[] = [
  { key: 'online', label: 'Online', view: 'online' },
  { key: 'offline', label: 'Offline', view: 'offline' },
  { key: 'active', label: 'Active', view: 'active' },
  { key: 'nonPayment', label: 'Non-pay', view: 'non-payment' },
  { key: 'expired', label: 'Expired', view: 'expired' },
  { key: 'total', label: 'Total', view: '' },
];

function num(v: unknown, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export default function HudHome({
  routerId,
  routerName,
  statusCounts,
}: {
  routerId?: number;
  routerName?: string;
  statusCounts?: Record<string, unknown> | null;
}) {
  const navigate = useNavigate();
  const [report, setReport] = useState<Report | null>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
  const rot = useRef({ x: -16, y: 24 });
  const drag = useRef<{ x: number; y: number; rx: number; ry: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    const q = routerId ? `?routerId=${routerId}` : '';
    api
      .get(`/dashboard/collection${q}`)
      .then((r) => setReport(r.data))
      .catch(() => setReport(null));
  }, [routerId]);

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      if (!drag.current && !reduced) rot.current.y += dt * 0.012;
      const el = sceneRef.current;
      if (el) el.style.transform = `rotateX(${rot.current.x}deg) rotateY(${rot.current.y}deg)`;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  const live = statusCounts || {};
  const counts = {
    total: num(live.total, report?.total ?? 0),
    online: num(live.online, report?.online ?? 0),
    offline: num(live.offline, report?.offline ?? 0),
    active: num(live.active, report?.active ?? 0),
    nonPayment: num(live.nonPayment, report?.nonPayment ?? 0),
    expired: num(live.expired, report?.expired ?? 0),
  };

  const pie = useMemo(() => {
    if (statusCounts) {
      return [
        { name: 'Online', value: counts.online, key: 'online' },
        { name: 'Offline', value: counts.offline, key: 'offline' },
        { name: 'Non-payment', value: counts.nonPayment, key: 'non-payment' },
        { name: 'Expired', value: counts.expired, key: 'expired' },
      ].filter((s) => s.value > 0);
    }
    return report?.pie || [];
  }, [statusCounts, counts.online, counts.offline, counts.nonPayment, counts.expired, report?.pie]);

  const money = [
    { name: 'Target', value: report?.target ?? 0, to: '/finance' },
    { name: 'Collected', value: report?.collected ?? 0, to: '/sales' },
    { name: 'Still open', value: report?.remaining ?? 0, to: '/invoices?status=open' },
  ];

  const valueOf = (key: string) => (counts as Record<string, number>)[key] ?? 0;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, rx: rot.current.x, ry: rot.current.y, moved: false };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
    rot.current.x = Math.max(-40, Math.min(20, d.rx - dy * 0.25));
    rot.current.y = d.ry + dx * 0.4;
  };
  const onPointerUp = () => {
    suppressClick.current = !!drag.current?.moved;
    drag.current = null;
  };
  const keepClick = (e: MouseEvent) => {
    if (!suppressClick.current) return;
    e.preventDefault();
    suppressClick.current = false;
  };

  return (
    <section className="hud-home mb-8" aria-label="Operations HUD">
      <div className="hud-frame">
        <header className="hud-head">
          <div>
            <p className="hud-kicker">Command home</p>
            <h2 className="hud-title">Subscriber HUD{routerName ? ` — ${routerName}` : ''}</h2>
            <p className="hud-lead">
              Drag the core. Each reading opens the page that holds that data.
            </p>
          </div>
          <div className="hud-live" title={statusCounts?.live ? 'Counts include the live router' : 'Counts from the panel database'}>
            <span className={`hud-live-dot ${statusCounts?.live ? 'is-on' : ''}`} />
            {statusCounts?.live ? 'Live router' : 'Panel data'}
          </div>
        </header>

        <div className="hud-grid">
          <div
            className="hud-stage"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <div className="hud-scene" ref={sceneRef}>
              <div className="hud-ring" />
              <div className="hud-ring hud-ring-b" />
              <Link to="/pppoe" className="hud-core" onClick={keepClick}>
                <span>Total subs</span>
                <strong>{counts.total}</strong>
              </Link>
              {NODES.filter((n) => n.key !== 'total').map((node, i) => (
                <Link
                  key={node.key}
                  to={node.view ? `/pppoe?view=${node.view}` : '/pppoe'}
                  className="hud-node"
                  style={{ transform: `rotateY(${i * 72}deg) translateZ(148px)` }}
                  onClick={keepClick}
                >
                  <span>{node.label}</span>
                  <strong>{valueOf(node.key)}</strong>
                </Link>
              ))}
            </div>
          </div>

          <div className="hud-panel">
            <div className="hud-panel-title">
              <span>Subscriber mix</span>
              <Link to="/pppoe">Open PPPoE</Link>
            </div>
            <div className="h-52">
              {pie.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={pie}
                      dataKey="value"
                      nameKey="name"
                      innerRadius={48}
                      outerRadius={74}
                      paddingAngle={2}
                      stroke="var(--page-fg)"
                      strokeWidth={1}
                      onClick={(_, index) => {
                        const key = pie[index]?.key;
                        if (key) navigate(`/pppoe?view=${key}`);
                      }}
                    >
                      {pie.map((slice) => (
                        <Cell key={slice.key} fill={SLICE_COLOR[slice.key] || '#38bdf8'} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <p className="hud-empty">No subscribers yet.</p>
              )}
            </div>
            <div className="hud-legend">
              {pie.map((slice) => (
                <Link key={slice.key} to={`/pppoe?view=${slice.key}`}>
                  <i style={{ background: SLICE_COLOR[slice.key] || '#38bdf8' }} />
                  {slice.name} <b>{slice.value}</b>
                </Link>
              ))}
            </div>
          </div>

          <div className="hud-panel">
            <div className="hud-panel-title">
              <span>This month collection</span>
              <Link to="/finance">Finance</Link>
            </div>
            <div className="hud-money">
              <Link to="/finance">
                <span>Target</span>
                <strong>{peso(report?.target ?? 0)}</strong>
              </Link>
              <Link to="/sales">
                <span>Collected</span>
                <strong>{peso(report?.collected ?? 0)}</strong>
              </Link>
              <Link to="/invoices?status=open">
                <span>Open AR</span>
                <strong>{peso(report?.openBalance ?? 0)}</strong>
              </Link>
            </div>
            <div className="h-36 mt-2">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={money} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--page-fg)' }} />
                  <YAxis hide />
                  <Tooltip formatter={(v: number) => peso(Number(v) || 0)} />
                  <Bar
                    dataKey="value"
                    radius={[6, 6, 0, 0]}
                    fill="var(--brand)"
                    onClick={(_, index) => {
                      const to = money[index]?.to;
                      if (to) navigate(to);
                    }}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        <div className="hud-tiles">
          <Link className="hud-tile" to="/pppoe?view=active"><span>Active</span><strong>{counts.active}</strong></Link>
          <Link className="hud-tile" to="/pppoe?view=online"><span>Online</span><strong>{counts.online}</strong></Link>
          <Link className="hud-tile" to="/pppoe?view=offline"><span>Offline</span><strong>{counts.offline}</strong></Link>
          <Link className="hud-tile" to="/pppoe?view=non-payment"><span>Non-payment</span><strong>{counts.nonPayment}</strong></Link>
          <Link className="hud-tile" to="/pppoe"><span>Total subs</span><strong>{counts.total}</strong></Link>
          <Link className="hud-tile" to="/sales"><span>Paid this month</span><strong>{report?.paidCount ?? 0}</strong></Link>
          <Link className="hud-tile" to="/sales"><span>Paid on time</span><strong>{report?.onTimeCount ?? 0}</strong></Link>
          <Link className="hud-tile" to="/invoices?status=open"><span>Not yet paid</span><strong>{report?.unpaidCount ?? 0}</strong></Link>
          <Link className="hud-tile" to="/sales"><span>Paid after due</span><strong>{report?.lateCount ?? 0}</strong></Link>
          <Link className="hud-tile" to="/pppoe"><span>Already covered</span><strong>{report?.coveredCount ?? 0}</strong></Link>
        </div>

        <div className="hud-lists">
          <div className="hud-panel">
            <div className="hud-panel-title">
              <span>Not paid</span>
              <Link to="/invoices?status=open">Invoices</Link>
            </div>
            {report?.unpaid?.length ? (
              <ul className="hud-people">
                {report.unpaid.map((row) => (
                  <li key={row.id}>
                    <Link to={`/pppoe?q=${encodeURIComponent(row.account)}`}>
                      <b>{row.name}</b>
                      <span>{row.account} · due {row.due || '—'}</span>
                    </Link>
                    <em>{peso(row.balance || row.price || 0)}</em>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hud-empty">No unpaid subscribers in this cycle.</p>
            )}
          </div>
          <div className="hud-panel">
            <div className="hud-panel-title">
              <span>Paid only after expiration</span>
              <Link to="/sales">Sales</Link>
            </div>
            {report?.late?.length ? (
              <ul className="hud-people">
                {report.late.map((row) => (
                  <li key={`${row.id}-${row.paidOn}`}>
                    <Link to={`/pppoe?q=${encodeURIComponent(row.account)}`}>
                      <b>{row.name}</b>
                      <span>due {row.previousDue} · paid {row.paidOn}</span>
                    </Link>
                    <em>{peso(row.amount)}</em>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hud-empty">No after-due payments recorded this month.</p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
