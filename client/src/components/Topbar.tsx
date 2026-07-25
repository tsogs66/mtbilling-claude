import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown, RefreshCw, LogOut, Router as RouterIcon, Menu,
  Sun, Moon, Anchor, Palette,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useRouterDevice } from '../context/RouterContext';
import { useTheme, type ThemeId } from '../context/ThemeContext';
import { useLayout } from './Layout';
import { PRODUCT_TITLE } from '../branding';
import { api } from '../api';
import { isNativeApp } from '../config';

const THEMES: { key: ThemeId; label: string; Icon: typeof Sun; hint: string }[] = [
  { key: 'light', label: 'Light', Icon: Sun, hint: 'Clean daylight panel' },
  { key: 'dark', label: 'Dark', Icon: Moon, hint: 'Low-light operations' },
  { key: 'onepiece', label: 'One Piece', Icon: Anchor, hint: 'Nautical map · gold & crimson' },
];

function ThemeIcon({ theme, size = 18 }: { theme: ThemeId; size?: number }) {
  if (theme === 'dark') return <Moon size={size} />;
  if (theme === 'onepiece') return <Anchor size={size} />;
  if (theme === 'light') return <Sun size={size} />;
  return <Palette size={size} />;
}

export default function Topbar({ title }: { title: string }) {
  const { logout, user } = useAuth();
  const { routers, current, setCurrent } = useRouterDevice();
  const { theme, setTheme } = useTheme();
  const { toggleSidebar } = useLayout();
  const [routerOpen, setRouterOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const routerRef = useRef<HTMLDivElement>(null);
  const themeRef = useRef<HTMLDivElement>(null);
  const userRef = useRef<HTMLDivElement>(null);
  const nativeShell = isNativeApp();

  useEffect(() => {
    const close = (e: Event) => {
      const t = e.target as Node;
      if (routerRef.current && !routerRef.current.contains(t)) setRouterOpen(false);
      if (themeRef.current && !themeRef.current.contains(t)) setThemeOpen(false);
      if (userRef.current && !userRef.current.contains(t)) setUserOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);

  const pickTheme = (key: ThemeId) => {
    setTheme(key);
    setThemeOpen(false);
    // Persist to panel settings (best-effort; local theme already applied).
    api.put('/settings/app', { theme: key }).catch(() => undefined);
  };

  return (
    <header className="theme-topbar sticky top-0 z-30 min-h-16 h-16 flex items-center justify-between gap-2 px-3 sm:px-6 lg:px-8 pt-[env(safe-area-inset-top)]">
      <div className="flex items-center gap-3 min-w-0">
        {!nativeShell && (
          <button
            type="button"
            onClick={toggleSidebar}
            className="theme-topbar-icon-btn lg:hidden p-2"
            aria-label="Open menu"
          >
            <Menu size={20} />
          </button>
        )}
        <div className="min-w-0">
          <h1 className="theme-topbar-title text-lg sm:text-xl font-bold tracking-tight truncate">{title}</h1>
          <p className="theme-topbar-subtitle text-[11px] hidden lg:block truncate max-w-[420px]" title={PRODUCT_TITLE}>
            {PRODUCT_TITLE}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 sm:gap-3">
        <div className="relative" ref={routerRef}>
          <button
            type="button"
            onClick={() => routers.length > 0 && setRouterOpen((v) => !v)}
            disabled={routers.length === 0}
            className="theme-topbar-pill text-sm"
          >
            <span className="theme-topbar-pill-icon hidden sm:flex">
              <RouterIcon size={15} />
            </span>
            <div className="text-left hidden sm:block">
              <div className="theme-topbar-pill-label">Active router</div>
              <div className="theme-topbar-pill-name">{current?.name ?? 'None'}</div>
            </div>
            <span className="theme-topbar-pill-name sm:hidden max-w-[80px] truncate">{current?.name ?? 'None'}</span>
            <ChevronDown
              size={14}
              className={`theme-topbar-subtitle transition-transform ${routerOpen ? 'rotate-180' : ''}`}
            />
          </button>

          {routerOpen && (
            <div className="theme-topbar-menu absolute right-0 mt-2 w-64 py-2 z-[600] animate-scale-in origin-top-right">
              <div className="theme-topbar-menu-muted px-3 py-2 text-[10px] font-bold uppercase tracking-wider">
                Select router
              </div>
              {routers.length === 0 ? (
                <div className="theme-topbar-menu-muted px-3 py-4 text-sm text-center">No routers configured</div>
              ) : (
                routers.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => {
                      setCurrent(r);
                      setRouterOpen(false);
                    }}
                    className={[
                      'theme-topbar-menu-item w-full text-left px-3 py-2.5 text-sm flex items-center gap-3 transition-colors',
                      r.id === current?.id ? 'is-active' : '',
                    ].join(' ')}
                  >
                    <span className="theme-topbar-menu-icon">
                      <RouterIcon size={15} />
                    </span>
                    <span className={r.id === current?.id ? 'font-semibold' : ''}>{r.name}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        <div className="relative" ref={themeRef}>
          <button
            type="button"
            className="theme-topbar-icon-btn p-2"
            title="Theme"
            aria-label="Theme selector"
            aria-expanded={themeOpen}
            onClick={() => setThemeOpen((v) => !v)}
          >
            <ThemeIcon theme={theme} />
          </button>

          {themeOpen && (
            <div className="theme-topbar-menu absolute right-0 mt-2 w-56 py-2 z-[600] animate-scale-in origin-top-right">
              <div className="theme-topbar-menu-muted px-3 py-2 text-[10px] font-bold uppercase tracking-wider">
                Theme
              </div>
              {THEMES.map(({ key, label, Icon, hint }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => pickTheme(key)}
                  className={[
                    'theme-topbar-menu-item w-full text-left px-3 py-2.5 text-sm flex items-center gap-3 transition-colors',
                    theme === key ? 'is-active' : '',
                  ].join(' ')}
                >
                  <span className="theme-topbar-menu-icon">
                    <Icon size={15} />
                  </span>
                  <span className="min-w-0">
                    <span className={`block ${theme === key ? 'font-semibold' : ''}`}>{label}</span>
                    <span className="theme-topbar-menu-muted block text-[10px] truncate">{hint}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          type="button"
          className="theme-topbar-icon-btn p-2"
          title="Refresh"
          onClick={() => location.reload()}
        >
          <RefreshCw size={18} />
        </button>

        <div className="theme-topbar-divider hidden sm:block" />

        <div className="relative" ref={userRef}>
          <button
            type="button"
            onClick={() => setUserOpen((v) => !v)}
            className="theme-topbar-user-btn"
          >
            <span className="theme-topbar-avatar">
              {(user?.username?.[0] || 'A').toUpperCase()}
            </span>
            <span className="text-sm font-medium hidden sm:block max-w-[100px] truncate">{user?.username}</span>
            <ChevronDown
              size={14}
              className={`theme-topbar-subtitle hidden sm:block transition-transform ${userOpen ? 'rotate-180' : ''}`}
            />
          </button>

          {userOpen && (
            <div className="theme-topbar-menu absolute right-0 mt-2 w-52 py-2 z-[600] animate-scale-in origin-top-right">
              <div className="px-4 py-3 border-b border-[var(--topbar-menu-border)]">
                <div className="text-sm font-semibold">{user?.username}</div>
                <div className="theme-topbar-menu-muted text-xs">{user?.role || '—'}</div>
              </div>
              <button
                type="button"
                onClick={logout}
                className="w-full text-left px-4 py-2.5 text-sm text-rose-500 hover:bg-rose-500/10 flex items-center gap-2 transition-colors"
              >
                <LogOut size={16} />
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
