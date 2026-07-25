import { useLayoutEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ChevronDown, X } from 'lucide-react';
import Logo from './Logo';
import { useLayout } from './Layout';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { buildNavSections } from '../navConfig';

/** Survives Layout remounts (each page wraps its own <Layout>). */
let savedSidebarScroll = 0;
const SIDEBAR_SCROLL_KEY = 'mt-sidebar-nav-scroll';

function readSavedScroll() {
  if (savedSidebarScroll > 0) return savedSidebarScroll;
  const n = Number(sessionStorage.getItem(SIDEBAR_SCROLL_KEY) || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function writeSavedScroll(y: number) {
  savedSidebarScroll = y;
  try {
    sessionStorage.setItem(SIDEBAR_SCROLL_KEY, String(y));
  } catch {
    /* ignore */
  }
}

export default function Sidebar() {
  const { sidebarOpen, setSidebarOpen } = useLayout();
  const { canAccess, canWrite, user } = useAuth();
  const { theme } = useTheme();
  const location = useLocation();
  const navRef = useRef<HTMLElement>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const logoVariant = theme === 'light' ? 'light' : 'dark';
  const viewerMode = !!user && !canWrite && !!user.licenseActivated;

  // Restore scroll before paint — Layout remounts on every route change.
  useLayoutEffect(() => {
    const el = navRef.current;
    if (!el) return;
    const y = readSavedScroll();
    el.scrollTop = y;
    // Focus/layout can still nudge scroll after paint — re-apply once.
    const id = requestAnimationFrame(() => {
      if (navRef.current) navRef.current.scrollTop = y;
    });
    return () => cancelAnimationFrame(id);
  }, [location.pathname]);

  const onNavScroll = () => {
    if (navRef.current) writeSavedScroll(navRef.current.scrollTop);
  };

  const rememberScroll = () => {
    if (navRef.current) writeSavedScroll(navRef.current.scrollTop);
  };

  const toggleSection = (title: string) => {
    setCollapsed((prev) => ({ ...prev, [title]: !prev[title] }));
  };

  const sections = buildNavSections(canAccess, user);

  return (
    <aside
      className={[
        'theme-sidebar fixed lg:sticky top-0 z-50 h-[100dvh] lg:h-full w-[min(var(--sidebar-width),100vw)] max-w-[100vw] shrink-0',
        'flex flex-col shadow-sidebar transition-transform duration-300 ease-out',
        'pb-[env(safe-area-inset-bottom)]',
        sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
      ].join(' ')}
    >
      <div className="theme-sidebar-header h-16 flex items-center justify-between px-4 shrink-0">
        <Logo size="sm" variant={logoVariant} />
        <button
          type="button"
          className="theme-sidebar-icon-btn lg:hidden p-1.5 rounded-lg transition-colors"
          onClick={() => setSidebarOpen(false)}
          aria-label="Close sidebar"
        >
          <X size={18} />
        </button>
      </div>

      <nav
        ref={navRef}
        onScroll={onNavScroll}
        className="flex-1 overflow-y-auto overflow-x-hidden sidebar-scroll py-3 px-2 overscroll-contain"
        style={{ overflowAnchor: 'none' }}
      >
        {!user?.licenseActivated && (
          <div className="theme-sidebar-banner mx-2 mb-3 rounded-lg px-3 py-2 text-[11px] leading-snug">
            License inactive — all menus are visible in <b>read-only</b> mode. Activate to enable edits.
          </div>
        )}
        {viewerMode && (
          <div className="theme-sidebar-banner mx-2 mb-3 rounded-lg px-3 py-2 text-[11px] leading-snug">
            Viewer account — full system access in <b>read-only</b> mode. Changes are disabled.
          </div>
        )}
        {sections.map((section) => {
          const isCollapsed = collapsed[section.title];
          return (
            <div key={section.title} className="mb-1">
              <button
                type="button"
                onClick={() => toggleSection(section.title)}
                className="theme-sidebar-section w-full flex items-center justify-between px-3 py-2 text-[10px] font-bold uppercase tracking-widest transition-colors"
              >
                <span>{section.title}</span>
                <ChevronDown
                  size={12}
                  className={`transition-transform duration-200 ${isCollapsed ? '-rotate-90' : ''}`}
                />
              </button>

              {!isCollapsed && (
                <div className="space-y-0.5">
                  {section.items.map((item) => {
                    const Icon = item.icon;
                    return (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        end={item.end}
                        onMouseDown={rememberScroll}
                        onClick={() => {
                          rememberScroll();
                          setSidebarOpen(false);
                          const y = readSavedScroll();
                          requestAnimationFrame(() => {
                            if (navRef.current) navRef.current.scrollTop = y;
                          });
                        }}
                        className={({ isActive }) =>
                          [
                            'theme-sidebar-link group relative flex items-center gap-3 px-3 py-2.5 text-sm rounded-xl mx-1 transition-all duration-200',
                            isActive ? 'is-active font-medium' : '',
                          ].join(' ')
                        }
                      >
                        {({ isActive }) => (
                          <>
                            {isActive && <span className="nav-active-indicator" />}
                            <span
                              className={[
                                'theme-sidebar-link-icon flex items-center justify-center w-8 h-8 rounded-lg transition-all duration-200',
                                isActive ? 'is-active' : '',
                              ].join(' ')}
                            >
                              <Icon size={17} strokeWidth={isActive ? 2.25 : 2} />
                            </span>
                            <span className="truncate">{item.label}</span>
                          </>
                        )}
                      </NavLink>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div className="theme-sidebar-footer px-4 py-4 shrink-0">
        <div className="theme-sidebar-user flex items-center gap-2 px-2 py-2 rounded-xl">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="theme-sidebar-user-name text-xs font-medium truncate">{user?.username || 'Panel'}</div>
            <div className="theme-sidebar-user-meta text-[10px] truncate">{user?.role || '—'} · ts0gs v1.0.0</div>
          </div>
        </div>
      </div>
    </aside>
  );
}
