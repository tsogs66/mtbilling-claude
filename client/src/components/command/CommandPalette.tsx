import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CornerDownLeft, Search, User } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { buildNavSections } from '../../navConfig';
import { useAuth } from '../../context/AuthContext';
import type { CcSubscriber } from '../../lib/commandModel';

export interface PaletteAction {
  id: string;
  label: string;
  hint?: string;
  icon: LucideIcon;
  run: () => void;
}

type Entry = {
  id: string;
  group: 'Actions' | 'Subscribers' | 'Pages';
  label: string;
  hint?: string;
  icon: LucideIcon;
  run: () => void;
};

export default function CommandPalette({
  open,
  onClose,
  subscribers,
  actions,
  onPickSubscriber,
}: {
  open: boolean;
  onClose: () => void;
  subscribers: CcSubscriber[];
  actions: PaletteAction[];
  onPickSubscriber: (s: CcSubscriber) => void;
}) {
  const navigate = useNavigate();
  const { canAccess, user } = useAuth();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  const entries = useMemo<Entry[]>(() => {
    const q = query.trim().toLowerCase();
    const list: Entry[] = [];
    for (const a of actions) {
      if (q && !`${a.label} ${a.hint || ''}`.toLowerCase().includes(q)) continue;
      list.push({ id: `a-${a.id}`, group: 'Actions', label: a.label, hint: a.hint, icon: a.icon, run: a.run });
    }
    if (q) {
      let n = 0;
      for (const s of subscribers) {
        if (!`${s.name} ${s.user} ${s.account}`.toLowerCase().includes(q)) continue;
        list.push({
          id: `s-${s.id}`,
          group: 'Subscribers',
          label: s.name,
          hint: `${s.account} · ${s.plan}`,
          icon: User,
          run: () => onPickSubscriber(s),
        });
        if (++n >= 6) break;
      }
    }
    for (const section of buildNavSections(canAccess, user)) {
      for (const item of section.items) {
        if (q && !`${item.label} ${section.title}`.toLowerCase().includes(q)) continue;
        list.push({
          id: `p-${item.to}`,
          group: 'Pages',
          label: item.label,
          hint: section.title,
          icon: item.icon,
          run: () => navigate(item.to),
        });
      }
    }
    return list.slice(0, 40);
  }, [query, actions, subscribers, canAccess, user, navigate, onPickSubscriber]);

  useEffect(() => setIndex(0), [query]);

  if (!open) return null;

  const choose = (entry?: Entry) => {
    if (!entry) return;
    onClose();
    entry.run();
  };

  let lastGroup = '';
  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-slate-950/55 px-4 pt-[12vh] backdrop-blur-sm" onMouseDown={onClose}>
      <div
        className="cc-palette w-full max-w-xl overflow-hidden rounded-xl border shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Command palette"
      >
        <div className="flex items-center gap-2 border-b px-3" style={{ borderColor: 'var(--card-border)' }}>
          <Search size={16} className="opacity-60" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIndex((i) => Math.min(entries.length - 1, i + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                choose(entries[index]);
              } else if (e.key === 'Escape') {
                onClose();
              }
            }}
            placeholder="Find a subscriber, jump to a page, or run an action"
            className="h-12 flex-1 bg-transparent text-sm outline-none"
          />
          <kbd className="cc-kbd">esc</kbd>
        </div>
        <ul className="max-h-[52vh] overflow-y-auto py-1">
          {entries.length === 0 && <li className="px-4 py-6 text-center text-sm opacity-60">Nothing matches that.</li>}
          {entries.map((entry, i) => {
            const header = entry.group !== lastGroup ? entry.group : null;
            lastGroup = entry.group;
            const Icon = entry.icon;
            return (
              <li key={entry.id}>
                {header && <p className="px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.16em] opacity-55">{header}</p>}
                <button
                  type="button"
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => choose(entry)}
                  className={`flex w-full items-center gap-3 px-4 py-2 text-left text-sm ${i === index ? 'cc-palette-on' : ''}`}
                >
                  <Icon size={15} className="shrink-0 opacity-70" />
                  <span className="flex-1 truncate">{entry.label}</span>
                  {entry.hint && <span className="truncate text-xs opacity-55">{entry.hint}</span>}
                  {i === index && <CornerDownLeft size={13} className="opacity-60" />}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
