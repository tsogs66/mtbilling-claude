import {
  LayoutDashboard, Bot, TerminalSquare, Network, Users, Share2, Map,
  BarChart3, Boxes, Wifi, FileCode2, Globe, Building2, Settings, ShieldCheck,
  DownloadCloud, ServerCog, ScrollText, KeyRound, Activity, Bell, Link2, PieChart,
  ShieldAlert, Cloud, Satellite, RadioTower,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type NavItem = { to: string; label: string; icon: LucideIcon; end?: boolean; permission: string };
export type NavSection = { title: string; items: NavItem[] };

export const NAV_SECTIONS: NavSection[] = [
  {
    title: 'Overview',
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true, permission: 'dashboard' },
    ],
  },
  {
    title: 'Subscribers',
    items: [
      { to: '/pppoe', label: 'PPPoE Management', icon: Users, permission: 'pppoe' },
      { to: '/ipoe', label: 'IPoE Management', icon: Share2, permission: 'ipoe' },
      { to: '/hotspot', label: 'Hotspot', icon: Wifi, permission: 'hotspot' },
      { to: '/usage', label: 'Usage Stats', icon: PieChart, permission: 'pppoe' },
      { to: '/fair-use', label: 'Fair Use Alerts', icon: ShieldAlert, permission: 'pppoe' },
    ],
  },
  {
    title: 'Network',
    items: [
      { to: '/network', label: 'Network', icon: Network, permission: 'network' },
      { to: '/map', label: 'Topology', icon: Map, permission: 'map' },
      { to: '/terminal', label: 'Terminal', icon: TerminalSquare, permission: 'terminal' },
      { to: '/ai-scripting', label: 'AI Scripting', icon: Bot, permission: 'ai' },
      { to: '/files', label: 'Mikrotik Files', icon: FileCode2, permission: 'files' },
      { to: '/zerotier', label: 'ZeroTier', icon: Globe, permission: 'zerotier' },
      { to: '/super-router', label: 'Super Router', icon: ServerCog, permission: 'super-router' },
    ],
  },
  {
    title: 'Billing',
    items: [
      { to: '/sales', label: 'Sales Report', icon: BarChart3, permission: 'sales' },
      { to: '/pay-portal', label: 'Payment Links', icon: Link2, permission: 'sales' },
      { to: '/inventory', label: 'Stock & Inventory', icon: Boxes, permission: 'inventory' },
      { to: '/notifications', label: 'Notifications', icon: Bell, permission: 'notifications' },
    ],
  },
  {
    title: 'System',
    items: [
      { to: '/company', label: 'Company', icon: Building2, permission: 'company' },
      { to: '/cloudflare', label: 'Cloudflare Access', icon: Cloud, permission: 'settings' },
      { to: '/settings', label: 'System Settings', icon: Settings, permission: 'settings' },
      { to: '/roles', label: 'Panel Roles', icon: ShieldCheck, permission: 'roles' },
      { to: '/uptime', label: 'Uptime Monitor', icon: Activity, permission: 'uptime' },
      { to: '/status-hub', label: 'Status Hub', icon: Satellite, permission: 'uptime' },
      { to: '/outage-monitor', label: 'Outage Monitor', icon: RadioTower, permission: 'uptime' },
      { to: '/logs', label: 'System Logs', icon: ScrollText, permission: 'logs' },
      { to: '/updater', label: 'Updater', icon: DownloadCloud, permission: 'updater' },
      { to: '/license', label: 'License', icon: KeyRound, permission: 'license' },
    ],
  },
];

/** Primary Android bottom tabs; "More" opens the full menu sheet. */
export type BottomTab = {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  permission: string;
  /** Paths that highlight this tab (includes `to`). */
  matchPaths: string[];
};

export const BOTTOM_NAV_TABS: BottomTab[] = [
  {
    to: '/',
    label: 'Home',
    icon: LayoutDashboard,
    end: true,
    permission: 'dashboard',
    matchPaths: ['/'],
  },
  {
    to: '/pppoe',
    label: 'Subs',
    icon: Users,
    permission: 'pppoe',
    matchPaths: ['/pppoe', '/ipoe', '/hotspot', '/usage', '/fair-use'],
  },
  {
    to: '/network',
    label: 'Network',
    icon: Network,
    permission: 'network',
    matchPaths: ['/network', '/map', '/terminal', '/ai-scripting', '/files', '/zerotier', '/super-router', '/routers'],
  },
  {
    to: '/sales',
    label: 'Billing',
    icon: BarChart3,
    permission: 'sales',
    matchPaths: ['/sales', '/pay-portal', '/inventory', '/notifications'],
  },
];

export function buildNavSections(
  canAccess: (permission: string) => boolean,
  user: { licenseActivated?: boolean } | null
): NavSection[] {
  return NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items
      .filter((item) => canAccess(item.permission))
      .map((item) =>
        item.to === '/'
          ? { ...item, label: user?.licenseActivated ? 'Dashboard' : 'System Overview' }
          : item
      ),
  })).filter((s) => s.items.length > 0);
}

/** Map pathname → permission key for route guards */
export function permissionForPath(pathname: string): string {
  if (pathname === '/' || pathname === '') return 'dashboard';
  const map: Record<string, string> = {
    '/terminal': 'terminal',
    '/ai-scripting': 'ai',
    '/routers': 'network',
    '/network': 'network',
    '/pppoe': 'pppoe',
    '/ipoe': 'ipoe',
    '/map': 'map',
    '/zerotier': 'zerotier',
    '/super-router': 'super-router',
    '/files': 'files',
    '/sales': 'sales',
    '/pay-portal': 'sales',
    '/usage': 'pppoe',
    '/fair-use': 'pppoe',
    '/inventory': 'inventory',
    '/hotspot': 'hotspot',
    '/notifications': 'notifications',
    '/uptime': 'uptime',
    '/status-hub': 'uptime',
    '/outage-monitor': 'uptime',
    '/logs': 'logs',
    '/company': 'company',
    '/cloudflare': 'settings',
    '/settings': 'settings',
    '/roles': 'roles',
    '/updater': 'updater',
    '/license': 'license',
  };
  return map[pathname] || 'dashboard';
}

export function isBottomTabActive(pathname: string, tab: BottomTab): boolean {
  if (tab.end && (pathname === '/' || pathname === '')) return true;
  return tab.matchPaths.some((p) => p !== '/' && (pathname === p || pathname.startsWith(`${p}/`)));
}

/** True when current route is only reachable via the More sheet (not a primary tab). */
export function isMoreMenuRoute(pathname: string): boolean {
  const onPrimary = BOTTOM_NAV_TABS.some((tab) => isBottomTabActive(pathname, tab));
  return !onPrimary;
}
