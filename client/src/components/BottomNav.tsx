import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { LayoutGrid, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import {
  BOTTOM_NAV_TABS,
  NAV_SECTIONS,
  buildNavSections,
  isBottomTabActive,
  isMoreMenuRoute,
  type BottomTab,
} from '../navConfig';
import { registerMoreMenuControl } from '../lib/nativeShell';

function canAccessBottomTab(tab: BottomTab, canAccess: (permission: string) => boolean): boolean {
  const paths = new Set(tab.matchPaths);
  paths.add(tab.to);
  for (const section of NAV_SECTIONS) {
    for (const item of section.items) {
      if (paths.has(item.to) && canAccess(item.permission)) return true;
    }
  }
  return false;
}

export default function BottomNav() {
  const { canAccess, user } = useAuth();
  const location = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  const sections = buildNavSections(canAccess, user);
  const tabs = BOTTOM_NAV_TABS.filter((tab) => canAccessBottomTab(tab, canAccess));
  const moreActive = isMoreMenuRoute(location.pathname);

  useEffect(() => {
    registerMoreMenuControl(moreOpen, () => setMoreOpen(false));
  }, [moreOpen]);

  useEffect(() => {
    setMoreOpen(false);
  }, [location.pathname]);

  if (tabs.length === 0) return null;

  return (
    <>
      {moreOpen && (
        <button
          type="button"
          aria-label="Close menu"
          className="fixed inset-0 z-[55] bg-slate-900/50 backdrop-blur-sm animate-fade-in lg:hidden"
          onClick={() => setMoreOpen(false)}
        />
      )}

      <div
        className={[
          'theme-bottom-nav-sheet fixed inset-x-0 bottom-0 z-[60] max-h-[min(85dvh,520px)] flex flex-col rounded-t-2xl shadow-2xl transition-transform duration-300 ease-out',
          moreOpen ? 'translate-y-0' : 'translate-y-full pointer-events-none',
        ].join(' ')}
        aria-hidden={!moreOpen}
      >
        <div className="theme-bottom-nav-sheet-header flex items-center justify-between px-4 py-3 shrink-0 border-b border-[var(--bottom-nav-border)]">
          <span className="text-sm font-semibold">All menus</span>
          <button
            type="button"
            className="theme-topbar-icon-btn p-2"
            aria-label="Close menu"
            onClick={() => setMoreOpen(false)}
          >
            <X size={18} />
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto overscroll-contain px-2 py-3 sidebar-scroll">
          {sections.map((section) => (
            <div key={section.title} className="mb-3">
              <div className="theme-sidebar-section px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest">
                {section.title}
              </div>
              <div className="space-y-0.5">
                {section.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.end}
                      onClick={() => setMoreOpen(false)}
                      className={({ isActive }) =>
                        [
                          'theme-sidebar-link group relative flex items-center gap-3 px-3 py-2.5 text-sm rounded-xl mx-1 transition-all duration-200',
                          isActive ? 'is-active font-medium' : '',
                        ].join(' ')
                      }
                    >
                      {({ isActive }) => (
                        <>
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
            </div>
          ))}
        </nav>
        <div className="shrink-0 pb-[env(safe-area-inset-bottom)]" />
      </div>

      <nav
        className="theme-bottom-nav fixed bottom-0 inset-x-0 z-50 flex items-stretch justify-around gap-0 border-t border-[var(--bottom-nav-border)] pb-[env(safe-area-inset-bottom)]"
        aria-label="Main navigation"
      >
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const active = isBottomTabActive(location.pathname, tab);
          return (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.end}
              className={[
                'theme-bottom-nav-item flex-1 flex flex-col items-center justify-center gap-0.5 py-2 min-h-[52px] max-w-[96px] transition-colors',
                active ? 'is-active' : '',
              ].join(' ')}
            >
              <Icon size={22} strokeWidth={active ? 2.25 : 2} />
              <span className="text-[10px] font-medium leading-tight truncate max-w-full px-1">{tab.label}</span>
            </NavLink>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreOpen((v) => !v)}
          className={[
            'theme-bottom-nav-item flex-1 flex flex-col items-center justify-center gap-0.5 py-2 min-h-[52px] max-w-[96px] transition-colors',
            moreActive || moreOpen ? 'is-active' : '',
          ].join(' ')}
          aria-expanded={moreOpen}
          aria-label="More menus"
        >
          <LayoutGrid size={22} strokeWidth={moreActive || moreOpen ? 2.25 : 2} />
          <span className="text-[10px] font-medium leading-tight">More</span>
        </button>
      </nav>
    </>
  );
}
