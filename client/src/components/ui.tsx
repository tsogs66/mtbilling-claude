import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';
import {
  Construction, Sparkles, X, Loader2, CheckCircle2, AlertCircle, Inbox, Search,
  ArrowUp, ArrowDown, ArrowUpDown,
} from 'lucide-react';

/** Prefer pinning username / customer / name columns on mobile (not checkbox/# columns). */
const FREEZE_COLUMN_KEYS = [
  'user',
  'username',
  'customer',
  'subscriber',
  'client',
  'name',
  'member',
  'item',
  'voucher',
  'code',
];

function findFreezeColumnIndex(
  columns: { key: string; label: ReactNode }[],
  enabled: boolean
): number {
  if (!enabled || columns.length === 0) return -1;
  for (const key of FREEZE_COLUMN_KEYS) {
    const i = columns.findIndex((c) => c.key.toLowerCase() === key);
    if (i >= 0) return i;
  }
  for (let i = 0; i < columns.length; i++) {
    const label = columns[i].label;
    if (typeof label !== 'string') continue;
    if (/\b(user|username|customer|subscriber|client|name|member)\b/i.test(label)) return i;
  }
  // Fallback: first non-selection column, else column 0
  const nonSel = columns.findIndex((c) => !/^(sel|select|#)$/i.test(c.key));
  return nonSel >= 0 ? nonSel : 0;
}

/* ─── Card ─── */

export function Card({
  title,
  right,
  children,
  className = '',
  interactive = false,
  icon: Icon,
  noPadding = false,
}: {
  title?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  interactive?: boolean;
  icon?: LucideIcon;
  noPadding?: boolean;
}) {
  return (
    <div className={`${interactive ? 'card-interactive' : 'card'} ${className}`}>
      {(title || right) && (
        <div className="card-header">
          {title && (
            <h3 className="card-title flex items-center gap-2">
              {Icon && (
                <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-brand-50 text-brand-500">
                  <Icon size={16} />
                </span>
              )}
              {title}
            </h3>
          )}
          {right}
        </div>
      )}
      <div className={noPadding ? '' : 'p-5'}>{children}</div>
    </div>
  );
}

/* ─── Progress ─── */

export function Progress({ value, color = 'bg-gradient-to-r from-brand-400 to-brand-500' }: { value: number; color?: string }) {
  const pct = Math.min(100, Math.max(0, value));
  return (
    <div className="w-full h-2.5 bg-slate-100 rounded-full overflow-hidden">
      <div
        className={`h-full ${color} rounded-full transition-all duration-700 ease-out relative`}
        style={{ width: `${pct}%` }}
      >
        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent animate-shimmer bg-[length:200%_100%]" />
      </div>
    </div>
  );
}

/* ─── Status badge ─── */

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-700 ring-1 ring-amber-200/60',
  submitted: 'bg-sky-100 text-sky-700 ring-1 ring-sky-200/60',
  paid: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200/60',
  rejected: 'bg-rose-100 text-rose-600 ring-1 ring-rose-200/60',
  expired: 'bg-rose-100 text-rose-600 ring-1 ring-rose-200/60',
  Active: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200/60',
  active: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200/60',
  running: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200/60',
  online: 'bg-sky-100 text-sky-700 ring-1 ring-sky-200/60',
  Online: 'bg-sky-100 text-sky-700 ring-1 ring-sky-200/60',
  Enabled: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200/60',
  live: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200/60',
  unused: 'bg-sky-100 text-sky-700 ring-1 ring-sky-200/60',
  inactive: 'bg-slate-100 text-slate-500 ring-1 ring-slate-200/60',
  'non-payment': 'bg-amber-100 text-amber-700 ring-1 ring-amber-200/60',
  disabled: 'bg-rose-100 text-rose-700 ring-1 ring-rose-200/60',
  Disabled: 'bg-rose-100 text-rose-700 ring-1 ring-rose-200/60',
  offline: 'bg-slate-100 text-slate-500 ring-1 ring-slate-200/60',
  Offline: 'bg-slate-100 text-slate-500 ring-1 ring-slate-200/60',
  Blocked: 'bg-rose-100 text-rose-700 ring-1 ring-rose-200/60',
  sent: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200/60',
  failed: 'bg-rose-100 text-rose-600 ring-1 ring-rose-200/60',
  'Low Stock': 'bg-amber-100 text-amber-700 ring-1 ring-amber-200/60',
  'Out of Stock': 'bg-rose-100 text-rose-600 ring-1 ring-rose-200/60',
  'In Stock': 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200/60',
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${STATUS_STYLES[status] || 'bg-slate-100 text-slate-600 ring-1 ring-slate-200/60'}`}>{status}</span>;
}

/* ─── Stat / StatTile ─── */

export function Stat({ label, value, sub, icon: Icon }: { label: string; value: ReactNode; sub?: ReactNode; icon?: LucideIcon }) {
  return (
    <div className="flex items-start gap-3">
      {Icon && (
        <span className="flex items-center justify-center w-9 h-9 rounded-xl bg-slate-100 text-slate-500 shrink-0">
          <Icon size={17} />
        </span>
      )}
      <div>
        <div className="text-xs font-medium text-slate-400 uppercase tracking-wide">{label}</div>
        <div className="text-xl font-bold text-slate-900 tracking-tight mt-0.5">{value}</div>
        {sub && <div className="text-xs text-slate-400 mt-0.5">{sub}</div>}
      </div>
    </div>
  );
}

export function StatTile({
  label,
  value,
  icon: Icon,
  tone = 'text-slate-800',
  accent = 'from-brand-500/10 to-transparent',
  dot,
  delay = 0,
}: {
  label: string;
  value: ReactNode;
  icon?: LucideIcon;
  tone?: string;
  accent?: string;
  dot?: string;
  delay?: number;
}) {
  return (
    <div className="stat-tile animate-fade-in-up" style={{ animationDelay: `${delay}ms`, opacity: 0 }}>
      <div className={`absolute top-0 right-0 w-24 h-24 bg-gradient-to-bl ${accent} rounded-bl-full pointer-events-none`} />
      <div className="relative flex items-center justify-between">
        <div>
          <div className={`text-2xl sm:text-3xl font-bold tracking-tight ${tone}`}>{value}</div>
          <div className="text-xs text-slate-500 flex items-center gap-1.5 mt-1 font-medium">
            {dot && <span className={`w-2 h-2 rounded-full ${dot} animate-pulse-soft`} />}
            {label}
          </div>
        </div>
        {Icon && (
          <span className="flex items-center justify-center w-10 h-10 rounded-xl bg-white/80 border border-slate-100 text-slate-400 shadow-sm">
            <Icon size={18} />
          </span>
        )}
      </div>
    </div>
  );
}

/* ─── Section / Page ─── */

export function SectionTitle({ children, icon: Icon }: { children: ReactNode; icon?: LucideIcon }) {
  return (
    <h2 className="section-title">
      {Icon && <Icon size={14} className="text-brand-500" />}
      {children}
    </h2>
  );
}

export function PageHeader({ title, description, icon: Icon }: { title: string; description?: string; icon?: LucideIcon }) {
  return (
    <div className="mb-6 animate-fade-in-up">
      <div className="flex items-center gap-3 mb-1">
        {Icon && (
          <span className="flex items-center justify-center w-10 h-10 rounded-xl bg-brand-50 text-brand-500">
            <Icon size={20} />
          </span>
        )}
        <h2 className="text-xl font-bold text-slate-900 tracking-tight">{title}</h2>
      </div>
      {description && <p className="text-sm text-slate-500 max-w-3xl ml-[52px]">{description}</p>}
    </div>
  );
}

export function PageStub({ title, description }: { title: string; description: string }) {
  return (
    <div className="card max-w-2xl mx-auto mt-8 p-12 text-center animate-scale-in">
      <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-slate-100 to-slate-200 text-slate-400 mb-5 animate-float">
        <Construction size={28} />
      </div>
      <div className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-brand-500 bg-brand-50 px-3 py-1 rounded-full mb-4">
        <Sparkles size={12} />
        Coming soon
      </div>
      <h2 className="text-2xl font-bold text-slate-800 mb-2 tracking-tight">{title}</h2>
      <p className="text-slate-500 max-w-md mx-auto leading-relaxed">{description}</p>
    </div>
  );
}

export function LoadingPage({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-20 text-slate-400 animate-fade-in">
      <Loader2 className="animate-spin text-brand-500" size={22} />
      <span className="text-sm font-medium">{label}</span>
    </div>
  );
}

/* ─── Tabs ─── */

export function TabPills({
  tabs,
  active,
  onChange,
}: {
  tabs: { key: string; label: string }[];
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="inline-flex gap-1 p-1 bg-slate-100 rounded-xl">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onChange(t.key)}
          className={[
            'text-xs font-semibold px-3 py-1.5 rounded-lg transition-all duration-200',
            active === t.key ? 'bg-white text-brand-600 shadow-sm' : 'text-slate-500 hover:text-slate-700',
          ].join(' ')}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function TabBar({
  tabs,
  active,
  onChange,
  className = '',
}: {
  tabs: { key: string; label: string; icon?: LucideIcon }[];
  active: string;
  onChange: (key: string) => void;
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-1 border-b border-slate-200/80 overflow-x-auto table-scroll-touch -mx-1 px-1 ${className}`}>
      {tabs.map((t) => {
        const Icon = t.icon;
        const isActive = active === t.key;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            className={[
              'relative flex items-center gap-2 px-4 py-3 min-h-11 text-sm font-medium whitespace-nowrap transition-colors shrink-0',
              isActive ? 'text-brand-600' : 'text-slate-500 hover:text-slate-700',
            ].join(' ')}
          >
            {Icon && <Icon size={16} className={isActive ? 'text-brand-500' : 'text-slate-400'} />}
            {t.label}
            {isActive && (
              <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-gradient-to-r from-brand-400 to-brand-600 rounded-full" />
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ─── Flash / Toast ─── */

export function Flash({ message, type = 'success', onDismiss }: { message: string; type?: 'success' | 'error' | 'info'; onDismiss?: () => void }) {
  if (!message) return null;
  const styles = {
    success: 'bg-emerald-50 text-emerald-800 border-emerald-200/80',
    error: 'bg-rose-50 text-rose-800 border-rose-200/80',
    info: 'bg-sky-50 text-sky-800 border-sky-200/80',
  };
  const icons = { success: CheckCircle2, error: AlertCircle, info: Sparkles };
  const Icon = icons[type];
  return (
    <div className={`mb-4 flex items-center gap-2.5 text-sm border rounded-xl px-4 py-3 animate-fade-in-up ${styles[type]}`}>
      <Icon size={18} className="shrink-0" />
      <span className="flex-1">{message}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="opacity-60 hover:opacity-100">
          <X size={16} />
        </button>
      )}
    </div>
  );
}

export function Toast({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div className="fixed bottom-[max(1.5rem,env(safe-area-inset-bottom))] right-4 left-4 sm:left-auto z-[2000] sm:max-w-sm animate-fade-in-up">
      <div className="flex items-center gap-2.5 bg-slate-900 text-white text-sm font-medium px-4 py-3 rounded-xl shadow-card-hover border border-slate-700/50">
        <CheckCircle2 size={18} className="text-emerald-400 shrink-0" />
        {message}
      </div>
    </div>
  );
}

/* ─── Modal ─── */

export function Modal({
  title,
  subtitle,
  children,
  footer,
  onClose,
  wide,
  maxWidth = 'md',
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  wide?: boolean;
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const widths = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-lg', xl: 'max-w-xl' };

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  return createPortal(
    <div
      className="theme-modal-backdrop fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-end sm:items-center justify-center z-[2000] p-0 sm:p-4 animate-fade-in"
      style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0 }}
      role="presentation"
    >
      <div
        className={`theme-modal bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full ${wide ? 'max-w-2xl' : widths[maxWidth]} max-h-[min(92dvh,90vh)] flex flex-col animate-scale-in border border-slate-200/80 pb-[env(safe-area-inset-bottom)]`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <div className="theme-modal-header flex items-start justify-between px-5 py-4 border-b border-slate-100 shrink-0">
          <div>
            <h3 id="modal-title" className="font-bold text-slate-900 text-lg tracking-tight">{title}</h3>
            {subtitle && <p className="text-sm text-slate-400 mt-0.5">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="p-5 overflow-y-auto flex-1 min-h-0">{children}</div>
        {footer && (
          <div className="theme-modal-footer flex flex-col-reverse sm:flex-row sm:justify-end gap-2 px-5 py-3 border-t border-slate-100 bg-slate-50/80 rounded-b-2xl shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

export function ModalFooter({ onCancel, onConfirm, confirmLabel = 'Save', busy, cancelLabel = 'Cancel' }: {
  onCancel: () => void;
  onConfirm?: () => void;
  confirmLabel?: string;
  busy?: boolean;
  cancelLabel?: string;
}) {
  return (
    <>
      <button type="button" className="btn-secondary w-full sm:w-auto" onClick={onCancel} disabled={busy}>{cancelLabel}</button>
      {onConfirm && (
        <button type="button" className="btn-primary w-full sm:w-auto" onClick={onConfirm} disabled={busy}>
          {busy ? <><Loader2 size={16} className="animate-spin" /> Saving…</> : confirmLabel}
        </button>
      )}
    </>
  );
}

/* ─── Table ─── */

export function DataTable({
  columns,
  rows,
  emptyMessage = 'No records found.',
  stickyHeader,
  sortable = true,
  freezeFirstColumn = true,
}: {
  columns: {
    key: string;
    label: ReactNode;
    align?: 'left' | 'right' | 'center';
    className?: string;
    sortable?: boolean;
  }[];
  rows: {
    key: string | number;
    cells: ReactNode[];
    /** Optional values used for sorting when header is clicked */
    sortValues?: Record<string, string | number | null | undefined>;
  }[];
  emptyMessage?: string;
  stickyHeader?: boolean;
  /** Enable click-to-sort on headers (default true). Per-column override via columns[].sortable */
  sortable?: boolean;
  /**
   * On mobile, pin username / customer / name (and any columns before it, e.g. checkbox)
   * while scrolling horizontally.
   */
  freezeFirstColumn?: boolean;
}) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const tableRef = useRef<HTMLTableElement>(null);
  const [freezeLefts, setFreezeLefts] = useState<number[]>([]);

  const freezeIdx = useMemo(
    () => findFreezeColumnIndex(columns, freezeFirstColumn),
    [columns, freezeFirstColumn]
  );

  const sortedRows = useMemo(() => {
    if (!sortKey) return rows;
    const colIdx = columns.findIndex((c) => c.key === sortKey);
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = a.sortValues?.[sortKey];
      const bv = b.sortValues?.[sortKey];
      let cmp = 0;
      if (av == null && bv == null) cmp = 0;
      else if (av == null) cmp = 1;
      else if (bv == null) cmp = -1;
      else if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
      else cmp = String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
      return sortDir === 'asc' ? cmp : -cmp;
    });
    // Keep colIdx referenced so unused-lint stays quiet if sortValues missing
    void colIdx;
    return copy;
  }, [rows, columns, sortKey, sortDir]);

  useLayoutEffect(() => {
    if (freezeIdx < 0) {
      setFreezeLefts([]);
      return;
    }
    const table = tableRef.current;
    if (!table) return;

    const measure = () => {
      const ths = table.querySelectorAll('thead th');
      let acc = 0;
      const next: number[] = [];
      for (let i = 0; i <= freezeIdx; i++) {
        next[i] = acc;
        acc += (ths[i] as HTMLElement | undefined)?.offsetWidth || 0;
      }
      setFreezeLefts((prev) => {
        if (prev.length === next.length && prev.every((v, i) => v === next[i])) return prev;
        return next;
      });
    };

    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(table);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [freezeIdx, columns, sortedRows.length]);

  const onHeaderClick = (key: string, colSortable?: boolean) => {
    if (!sortable || colSortable === false) return;
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const freezeStyle = (i: number): CSSProperties | undefined => {
    if (freezeIdx < 0 || i > freezeIdx) return undefined;
    return { left: freezeLefts[i] ?? 0 };
  };

  const freezeClass = (i: number) => {
    if (freezeIdx < 0 || i > freezeIdx) return '';
    return [
      'data-table-freeze-cell',
      i === freezeIdx ? 'data-table-freeze-edge' : '',
    ]
      .filter(Boolean)
      .join(' ');
  };

  return (
    <div className="table-scroll-touch overflow-x-auto rounded-xl border border-slate-100/80 -mx-0.5 px-0.5">
      <table
        ref={tableRef}
        className={['data-table w-full text-sm', freezeIdx >= 0 ? 'data-table--freeze-first' : '']
          .filter(Boolean)
          .join(' ')}
      >
        <thead className={stickyHeader ? 'sticky top-0 z-10' : ''}>
          <tr>
            {columns.map((c, i) => {
              const canSort = sortable && c.sortable !== false;
              const active = sortKey === c.key;
              return (
                <th
                  key={c.key}
                  className={[
                    c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left',
                    c.className,
                    canSort ? 'cursor-pointer select-none hover:text-slate-800' : '',
                    freezeClass(i),
                  ].filter(Boolean).join(' ')}
                  style={freezeStyle(i)}
                  onClick={() => onHeaderClick(c.key, c.sortable)}
                  title={canSort ? 'Click to sort' : undefined}
                >
                  <span className={`inline-flex items-center gap-1 ${c.align === 'right' ? 'justify-end w-full' : ''}`}>
                    {c.label}
                    {canSort && (
                      active ? (
                        sortDir === 'asc' ? <ArrowUp size={12} className="text-brand-500" /> : <ArrowDown size={12} className="text-brand-500" />
                      ) : (
                        <ArrowUpDown size={12} className="opacity-30" />
                      )
                    )}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sortedRows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="text-center text-slate-400 py-10">
                {emptyMessage}
              </td>
            </tr>
          ) : (
            sortedRows.map((r) => (
              <tr key={r.key}>
                {r.cells.map((cell, j) => (
                  <td
                    key={j}
                    className={[
                      columns[j]?.align === 'right' ? 'text-right' : columns[j]?.align === 'center' ? 'text-center' : '',
                      freezeClass(j),
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    style={freezeStyle(j)}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}


export function EmptyState({ message, icon: Icon = Inbox }: { message: string; icon?: LucideIcon }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-slate-400">
      <span className="flex items-center justify-center w-12 h-12 rounded-2xl bg-slate-100 mb-3">
        <Icon size={22} className="text-slate-300" />
      </span>
      <p className="text-sm">{message}</p>
    </div>
  );
}

/* ─── Form helpers ─── */

export function FormField({ label, hint, children, required }: { label: string; hint?: string; children: ReactNode; required?: boolean }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-700 mb-1.5 block">
        {label}
        {required && <span className="text-rose-500 ml-0.5">*</span>}
      </span>
      {children}
      {hint && <span className="text-xs text-slate-400 mt-1 block">{hint}</span>}
    </label>
  );
}

export function SearchInput({ value, onChange, placeholder, className = '' }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={`relative ${className}`}>
      <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="input pl-9 py-2"
      />
    </div>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: () => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onChange}
      className={`relative w-11 h-6 rounded-full transition-all duration-300 shrink-0 ${on ? 'bg-gradient-to-r from-brand-500 to-brand-600 shadow-glow-sm' : 'bg-slate-300'}`}
    >
      <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition-transform duration-300 ${on ? 'translate-x-5' : ''}`} />
    </button>
  );
}

export function IconAction({
  icon: Icon,
  title,
  onClick,
  tone = 'default',
}: {
  icon: LucideIcon;
  title: string;
  onClick: () => void;
  tone?: 'default' | 'sky' | 'emerald' | 'rose' | 'brand';
}) {
  const tones = {
    default: 'hover:text-slate-700 hover:bg-slate-100',
    sky: 'hover:text-sky-600 hover:bg-sky-50',
    emerald: 'hover:text-emerald-600 hover:bg-emerald-50',
    rose: 'hover:text-rose-600 hover:bg-rose-50',
    brand: 'hover:text-brand-600 hover:bg-brand-50',
  };
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`p-1.5 rounded-lg text-slate-400 transition-colors ${tones[tone]}`}
    >
      <Icon size={16} />
    </button>
  );
}

export function Toolbar({ left, right }: { left?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-5 py-3 gap-3 flex-wrap border-b border-slate-100/80 bg-slate-50/40">
      <div className="text-sm text-slate-500">{left}</div>
      <div className="flex items-center gap-2 flex-wrap">{right}</div>
    </div>
  );
}

export function SettingsSection({
  icon: Icon,
  title,
  children,
  className = '',
}: {
  icon?: LucideIcon;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={`max-w-4xl ${className}`} noPadding>
      <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-100 bg-gradient-to-r from-brand-50/50 to-transparent">
        {Icon && (
          <span className="flex items-center justify-center w-9 h-9 rounded-xl bg-brand-100 text-brand-600">
            <Icon size={18} />
          </span>
        )}
        <h3 className="font-bold text-slate-800 text-lg tracking-tight">{title}</h3>
      </div>
      <div className="p-6">{children}</div>
    </Card>
  );
}

export function LogPanel({
  title,
  onRefresh,
  children,
}: {
  title: string;
  onRefresh: () => void;
  children: ReactNode;
}) {
  return (
    <Card title={title} noPadding interactive right={
      <button type="button" className="btn-secondary text-xs py-1.5 px-3" onClick={onRefresh}>
        Refresh
      </button>
    }>
      <div className="p-4">{children}</div>
    </Card>
  );
}

export const logBoxClass = 'bg-slate-950 border border-slate-800 rounded-xl p-4 h-[60vh] overflow-auto font-mono text-[12px] leading-relaxed text-slate-300';
