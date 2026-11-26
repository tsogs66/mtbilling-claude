/**
 * Shared building blocks for the Command Center page family: money and count
 * formatters, the tone palette, the readings row, section heads, popovers,
 * tabs and the table. Pages compose these so they read as one product.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import type { Tone } from '../../lib/commandModel';

export const TONE_VAR: Record<Tone, string> = {
  good: 'var(--cc-good)',
  warn: 'var(--cc-warn)',
  bad: 'var(--cc-bad)',
  info: 'var(--cc-info)',
  mute: 'var(--cc-mute)',
  hot: 'var(--cc-hot)',
};

export const money = (n: number) => `\u20b1${Math.round(n || 0).toLocaleString('en-PH')}`;
export const moneyExact = (n: number) =>
  `\u20b1${(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const num = (n: number) => (n || 0).toLocaleString('en-PH');
export const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
export const compactMoney = (v: number) => {
  const n = Number(v) || 0;
  if (n >= 1_000_000) return `\u20b1${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `\u20b1${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return `\u20b1${Math.round(n)}`;
};

export function useClickAway(ref: React.RefObject<HTMLElement>, onAway: () => void) {
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onAway();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [ref, onAway]);
}

export function Dot({ tone }: { tone: Tone }) {
  return <span className="cc-dot inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: TONE_VAR[tone] }} />;
}

export function Popover({
  label, icon, badge, children, align = 'left',
}: { label: string; icon: ReactNode; badge?: string | number; children: ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickAway(ref, () => setOpen(false));
  return (
    <div className="relative" ref={ref}>
      <button type="button" className={`cc-btn ${open ? 'is-on' : ''}`} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {icon}
        <span>{label}</span>
        {badge ? <span className="cc-badge">{badge}</span> : null}
        <ChevronDown size={13} className="opacity-60" />
      </button>
      {open && <div className={`cc-pop ${align === 'right' ? 'right-0' : 'left-0'}`}>{children}</div>}
    </div>
  );
}

export function PanelHead({ title, note, actions }: { title: string; note?: string; actions?: ReactNode }) {
  return (
    <div className="mb-2 flex flex-wrap items-end justify-between gap-2 border-t pt-3" style={{ borderColor: 'var(--card-border)' }}>
      <div>
        <h3 className="text-sm font-semibold tracking-wide">{title}</h3>
        {note && <p className="text-[11px] opacity-60">{note}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-3">{actions}</div>}
    </div>
  );
}

export function PageBar({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="mr-auto min-w-0">
        <h2 className="font-display text-xl font-bold tracking-tight sm:text-2xl">{title}</h2>
        {subtitle && <p className="text-xs opacity-60">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

export function SearchBox({
  value, onChange, placeholder, inputRef,
}: { value: string; onChange: (v: string) => void; placeholder: string; inputRef?: React.RefObject<HTMLInputElement> }) {
  return (
    <label className="cc-search">
      <Search size={14} className="opacity-60" />
      <input ref={inputRef} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
      {value && (
        <button type="button" className="opacity-60 hover:opacity-100" onClick={() => onChange('')} aria-label="Clear search">
          <X size={13} />
        </button>
      )}
    </label>
  );
}

export function Seg<T extends string>({
  options, value, onChange, label,
}: { options: { key: T; label: string; hint?: string }[]; value: T; onChange: (k: T) => void; label: string }) {
  return (
    <div className="cc-seg cc-seg-lens" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button key={o.key} type="button" role="tab" aria-selected={value === o.key} title={o.hint} className={value === o.key ? 'is-on' : ''} onClick={() => onChange(o.key)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({
  tabs, value, onChange,
}: { tabs: { key: T; label: string; count?: number }[]; value: T; onChange: (k: T) => void }) {
  return (
    <div className="cc-tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.key} type="button" role="tab" aria-selected={value === t.key} className={value === t.key ? 'is-on' : ''} onClick={() => onChange(t.key)}>
          {t.label}
          {t.count != null && <span>{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Readings({ count, children, label = 'Readings' }: { count: number; children: ReactNode; label?: string }) {
  const style = {
    '--cc-cols': count,
    '--cc-cols-md': count <= 4 ? count : Math.ceil(count / 2),
  } as CSSProperties;
  return (
    <section aria-label={label} className="cc-pulse" style={style}>
      {children}
    </section>
  );
}

export function Reading({
  label, value, sub, tone, on, onClick, bar,
}: { label: string; value: string; sub?: string; tone?: Tone; on?: boolean; onClick?: () => void; bar?: number }) {
  const body = (
    <>
      <span className="cc-pulse-label">
        {tone && <Dot tone={tone} />}
        {label}
      </span>
      <span className="cc-pulse-value" style={tone ? { color: TONE_VAR[tone] } : undefined}>{value}</span>
      {sub && <span className="cc-pulse-sub">{sub}</span>}
      {bar != null && <span className="cc-pulse-bar"><i style={{ width: `${Math.round(Math.min(1, Math.max(0, bar)) * 100)}%` }} /></span>}
    </>
  );
  if (!onClick) return <div className="cc-pulse-item">{body}</div>;
  return (
    <button type="button" onClick={onClick} className={`cc-pulse-item ${on ? 'is-on' : ''}`} aria-pressed={!!on}>
      {body}
    </button>
  );
}

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="cc-pill" style={{ color: TONE_VAR[tone], borderColor: `color-mix(in srgb, ${TONE_VAR[tone]} 45%, transparent)` }}>
      {children}
    </span>
  );
}

export interface Col<T> {
  key: string;
  label: ReactNode;
  align?: 'left' | 'right';
  render: (row: T) => ReactNode;
  className?: string;
}

/** Hairline table: no card, no zebra, row hover only. */
export function Table<T>({
  columns, rows, rowKey, empty, onRowClick, activeKey, limit = 50,
}: {
  columns: Col<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  empty: string;
  onRowClick?: (row: T) => void;
  activeKey?: string | number | null;
  limit?: number;
}) {
  const [shown, setShown] = useState(limit);
  useEffect(() => setShown(limit), [rows.length, limit]);
  if (rows.length === 0) return <p className="cc-empty">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="cc-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={c.align === 'right' ? 'text-right' : ''}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, shown).map((row) => {
            const key = rowKey(row);
            return (
              <tr key={key} className={`${onRowClick ? 'is-click' : ''} ${activeKey === key ? 'is-on' : ''}`} onClick={onRowClick ? () => onRowClick(row) : undefined}>
                {columns.map((c) => (
                  <td key={c.key} className={`${c.align === 'right' ? 'text-right' : ''} ${c.className || ''}`}>{c.render(row)}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length > shown && (
        <div className="py-2 text-center">
          <button type="button" className="cc-link" onClick={() => setShown((s) => s + 100)}>
            Show {Math.min(100, rows.length - shown)} more of {num(rows.length - shown)}
          </button>
        </div>
      )}
    </div>
  );
}

export function downloadCsv(name: string, header: string[], rows: (string | number | null | undefined)[][]) {
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const body = [header.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n');
  const url = URL.createObjectURL(new Blob([body], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
