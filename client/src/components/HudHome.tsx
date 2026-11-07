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

  const readings = [
    { label: 'Active', value: counts.active, to: '/pppoe?view=active' },
    { label: 'Online', value: counts.online, to: '/pppoe?view=online' },
    { label: 'Offline', value: counts.offline, to: '/pppoe?view=offline' },
    { label: 'Non-payment', value: counts.nonPayment, to: '/pppoe?view=non-payment' },
    { label: 'Total', value: counts.total, to: '/pppoe' },
    { label: 'Paid', value: report?.paidCount ?? 0, to: '/sales' },
    { label: 'On time', value: report?.onTimeCount ?? 0, to: '/sales' },
    { label: 'Not paid', value: report?.unpaidCount ?? 0, to: '/invoices?status=open' },
    { label: 'After due', value: report?.lateCount ?? 0, to: '/sales' },
    { label: 'Covered', value: report?.coveredCount ?? 0, to: '/pppoe' },
  ];

  return (
    <section className="hud-home" aria-label="Operations HUD">
      <header className="hud-head">
        <div>
          <p className="hud-kicker">Command home</p>
          <h2 className="hud-title">Subscriber HUD{routerName ? ` — ${routerName}` : ''}</h2>
        </div>
        <p className="hud-live" title={statusCounts?.live ? 'Counts include the live router' : 'Counts from the panel database'}>
          <span className={`hud-live-dot ${statusCounts?.live ? 'is-on' : ''}`} />
          {statusCounts?.live ? 'Live router' : 'Panel data'}
          <span className="hud-lead">Drag the core. A reading opens its page.</span>
        </p>
      </header>

      <div className="hud-stage-row">
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
              <span>Total</span>
              <strong>{counts.total}</strong>
            </Link>
            {NODES.filter((n) => n.key !== 'total').map((node, i) => (
              <Link
                key={node.key}
                to={`/pppoe?view=${node.view}`}
                className="hud-node"
                style={{ transform: `rotateY(${i * 72}deg) translateZ(132px)` }}
                onClick={keepClick}
              >
                <span>{node.label}</span>
                <strong>{valueOf(node.key)}</strong>
              </Link>
            ))}
          </div>
        </div>

        <div className="hud-chart">
          <div className="hud-chart-label">
            <span>Mix</span>
            <Link to="/pppoe">PPPoE</Link>
          </div>
          <div className="hud-pie">
            {pie.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pie}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={46}
                    outerRadius={70}
                    paddingAngle={2}
                    stroke="transparent"
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
          <p className="hud-legend">
            {pie.map((slice) => (
              <Link key={slice.key} to={`/pppoe?view=${slice.key}`}>
                <i style={{ background: SLICE_COLOR[slice.key] || '#38bdf8' }} />
                {slice.name} {slice.value}
              </Link>
            ))}
          </p>
        </div>

        <div className="hud-chart">
          <div className="hud-chart-label">
            <span>This month</span>
            <Link to="/finance">Finance</Link>
          </div>
          <p className="hud-money">
            <Link to="/finance"><span>Target</span> {peso(report?.target ?? 0)}</Link>
            <Link to="/sales"><span>Collected</span> {peso(report?.collected ?? 0)}</Link>
            <Link to="/invoices?status=open"><span>Open</span> {peso(report?.openBalance ?? 0)}</Link>
          </p>
          <div className="hud-bars">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={money} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--page-fg)' }} axisLine={false} tickLine={false} />
                <YAxis hide />
                <Tooltip formatter={(v: number) => peso(Number(v) || 0)} />
                <Bar
                  dataKey="value"
                  radius={[4, 4, 0, 0]}
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

      <nav className="hud-readout" aria-label="Subscriber readings">
        {readings.map((item) => (
          <Link key={item.label} to={item.to}>
            <strong>{item.value}</strong>
            <span>{item.label}</span>
          </Link>
        ))}
      </nav>

      <div className="hud-names">
        <div>
          <p className="hud-chart-label">
            <span>Not paid</span>
            <Link to="/invoices?status=open">Invoices</Link>
          </p>
          {report?.unpaid?.length ? (
            <ul>
              {report.unpaid.map((row) => (
                <li key={row.id}>
                  <Link to={`/pppoe?q=${encodeURIComponent(row.account)}`}>
                    {row.name}
                    <span>{row.account} · due {row.due || '—'}</span>
                  </Link>
                  <em>{peso(row.balance || row.price || 0)}</em>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hud-empty">None this cycle.</p>
          )}
        </div>
        <div>
          <p className="hud-chart-label">
            <span>Paid after expiration</span>
            <Link to="/sales">Sales</Link>
          </p>
          {report?.late?.length ? (
            <ul>
              {report.late.map((row) => (
                <li key={`${row.id}-${row.paidOn}`}>
                  <Link to={`/pppoe?q=${encodeURIComponent(row.account)}`}>
                    {row.name}
                    <span>due {row.previousDue} · paid {row.paidOn}</span>
                  </Link>
                  <em>{peso(row.amount)}</em>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hud-empty">None this month.</p>
          )}
        </div>
      </div>
    </section>
  );
}
