import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bell, CheckCheck, FileWarning, Link2, RadioTower, Wallet, Zap, Loader2, X,
} from 'lucide-react';
import { api } from '../api';
import { subscribePortalLive } from '../lib/portalLive';

type StaffNotification = {
  id: number;
  type: 'plan_change' | 'ticket' | 'outage_report' | 'payment_link_created' | 'payment_submitted' | string;
  title: string;
  body?: string | null;
  entityId?: number | null;
  createdAt: string;
  read: boolean;
  href?: string | null;
};

const LIVE_TYPES = new Set([
  'plan_change',
  'ticket',
  'outage_report',
  'payment_link_created',
  'payment_submitted',
]);

function iconFor(type: string) {
  if (type === 'plan_change') return Zap;
  if (type === 'ticket') return FileWarning;
  if (type === 'outage_report') return RadioTower;
  if (type === 'payment_link_created') return Link2;
  if (type === 'payment_submitted') return Wallet;
  return Bell;
}

function formatWhen(raw?: string) {
  if (!raw) return '';
  const d = new Date(String(raw).includes('T') ? raw : String(raw).replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return String(raw).replace('T', ' ').slice(0, 16);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'Just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function TopbarNotifications() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<StaffNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const load = async () => {
    try {
      setLoading(true);
      const r = await api.get('/staff-notifications', { params: { limit: 40 } });
      setItems(r.data?.items || []);
      setUnread(Number(r.data?.unreadCount) || 0);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    const token = localStorage.getItem('mt_token') || '';
    const stop = subscribePortalLive({
      path: '/client-portal/events',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      onEvent: (event, data) => {
        if (!LIVE_TYPES.has(event)) return;
        // Staff inbox rows only for subscriber-created actions (admin accept/reject omit notificationId).
        if (event === 'plan_change' && data?.action && data.action !== 'created') return;
        if (data?.payload?.notificationId || data?.action === 'created' || event.startsWith('payment_')) {
          void load();
        }
      },
    });
    return stop;
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKey);
    // Prevent background scroll while the mobile sheet is open.
    const prev = document.body.style.overflow;
    const isNarrow = typeof window !== 'undefined' && window.matchMedia('(max-width: 639px)').matches;
    if (isNarrow) document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  const markRead = async (ids?: number[], all = false) => {
    try {
      const r = await api.post('/staff-notifications/read', all ? { all: true } : { ids });
      setUnread(Number(r.data?.unreadCount) || 0);
      if (all) {
        setItems((prev) => prev.map((n) => ({ ...n, read: true })));
      } else if (ids?.length) {
        const set = new Set(ids);
        setItems((prev) => prev.map((n) => (set.has(n.id) ? { ...n, read: true } : n)));
      }
    } catch {
      /* ignore */
    }
  };

  const openItem = (n: StaffNotification) => {
    if (!n.read) void markRead([n.id]);
    setOpen(false);
    if (n.href) navigate(n.href);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className="theme-topbar-icon-btn relative p-2"
        title="Notifications"
        aria-label="Notifications"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
          if (!open) void load();
        }}
      >
        <Bell size={18} />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-orange-500 text-[10px] font-bold text-slate-950 flex items-center justify-center leading-none shadow-[0_0_0_2px_var(--topbar-bg,#020617)]">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <>
          {/* Mobile backdrop — keeps the panel readable and closes on tap outside */}
          <button
            type="button"
            className="fixed inset-0 z-[590] bg-black/45 sm:hidden"
            aria-label="Close notifications"
            onClick={() => setOpen(false)}
          />

          <div
            className={[
              'theme-topbar-menu z-[600] flex flex-col overflow-hidden animate-scale-in',
              // Mobile: fixed sheet under the topbar, fully on-screen
              'fixed left-3 right-3 top-[calc(env(safe-area-inset-top,0px)+4.25rem)]',
              'max-h-[min(70dvh,calc(100dvh-5.5rem))] rounded-2xl shadow-2xl origin-top',
              // Desktop: anchored dropdown beside the bell
              'sm:absolute sm:left-auto sm:right-0 sm:top-auto sm:mt-2',
              'sm:w-[min(22rem,calc(100vw-1.5rem))] sm:max-h-[min(24rem,60vh)]',
              'sm:rounded-xl sm:shadow-xl sm:origin-top-right',
            ].join(' ')}
            role="dialog"
            aria-label="Notifications"
          >
            <div className="px-3 py-2.5 flex items-center justify-between gap-2 border-b border-[var(--topbar-menu-border)] shrink-0">
              <div className="min-w-0">
                <div className="text-[10px] font-bold uppercase tracking-wider theme-topbar-menu-muted">
                  Notifications
                </div>
                <div className="text-xs theme-topbar-menu-muted truncate">
                  Portal, outages & payments
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-orange-400 hover:text-orange-300 disabled:opacity-40 px-2 py-1.5 rounded-lg"
                  disabled={!unread}
                  onClick={() => void markRead(undefined, true)}
                  title="Mark all read"
                >
                  <CheckCheck size={14} />
                  <span className="hidden xs:inline sm:inline">Mark all</span>
                </button>
                <button
                  type="button"
                  className="sm:hidden theme-topbar-icon-btn p-1.5 rounded-lg"
                  aria-label="Close"
                  onClick={() => setOpen(false)}
                >
                  <X size={16} />
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {loading && !items.length && (
                <div className="px-3 py-8 text-center theme-topbar-menu-muted text-sm flex items-center justify-center gap-2">
                  <Loader2 size={16} className="animate-spin" /> Loading…
                </div>
              )}
              {!loading && !items.length && (
                <div className="px-3 py-8 text-center theme-topbar-menu-muted text-sm">
                  No portal activity yet.
                </div>
              )}
              {items.map((n) => {
                const Icon = iconFor(n.type);
                return (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => openItem(n)}
                    className={[
                      'theme-topbar-menu-item w-full text-left px-3 py-3 sm:py-2.5 flex items-start gap-3 transition-colors',
                      !n.read ? 'is-active' : '',
                    ].join(' ')}
                  >
                    <span className="theme-topbar-menu-icon mt-0.5 shrink-0">
                      <Icon size={15} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-start justify-between gap-2">
                        <span className={`block text-sm leading-snug break-words ${!n.read ? 'font-semibold' : ''}`}>
                          {n.title}
                        </span>
                        {!n.read && (
                          <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-orange-400 shrink-0" />
                        )}
                      </span>
                      {n.body && (
                        <span className="theme-topbar-menu-muted block text-[11px] mt-0.5 leading-snug line-clamp-3 sm:line-clamp-2 break-words">
                          {n.body}
                        </span>
                      )}
                      <span className="theme-topbar-menu-muted block text-[10px] mt-1">
                        {formatWhen(n.createdAt)}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
