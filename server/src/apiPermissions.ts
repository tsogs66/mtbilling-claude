/**
 * Path-based permission gates for the authenticated /api surface.
 *
 * The sidebar already hides menus a role cannot use; this is the server-side
 * enforcement so a direct API call cannot step around it. Rules are evaluated
 * in order and the FIRST match decides, so a specific path must be listed
 * before the prefix that would otherwise swallow it.
 *
 * Kept in its own module so the table can be unit-tested (apiPermissions.test.ts)
 * instead of only being exercised by booting the whole server.
 */
export type ApiPermissionRule = { re: RegExp; perms: string[]; writeOnly?: boolean };

export const API_PERMISSION_RULES: ApiPermissionRule[] = [
  { re: /^\/(roles|panel-users)(\/|$)/, perms: ['roles'] },
  { re: /^\/(db\/backup|db\/backups|db\/restore)/, perms: ['settings'] },
  { re: /^\/payment-links(\/|$)/, perms: ['sales'] },
  { re: /^\/merchant-deposits(\/|$)/, perms: ['sales'] },
  { re: /^\/merchants(\/|$)/, perms: ['roles'] },
  { re: /^\/cashiers(\/|$)/, perms: ['roles'] },
  { re: /^\/job-orders(\/|$)/, perms: ['job-orders'] },
  { re: /^\/invoices(\/|$)/, perms: ['invoices'] },
  { re: /^\/finance(\/|$)/, perms: ['finance'] },
  { re: /^\/notifications(\/|$)/, perms: ['notifications'] },
  { re: /^\/inventory(\/|$)/, perms: ['inventory'] },
  { re: /^\/pppoe(\/|$)/, perms: ['pppoe'] },
  // Operations desk. Specific paths first — the generic /isp rule below is the
  // catch-all, and the first matching rule wins.
  // Cleartext PPPoE secrets for a RADIUS server: treat like a settings export.
  { re: /^\/isp\/radius-users(\/|$)/, perms: ['settings'] },
  // Branch name, BIR receipt series and the dunning template are policy.
  { re: /^\/isp\/settings(\/|$)/, perms: ['settings'], writeOnly: true },
  // Taking money, reversing a receipt and closing a drawer are cashier work.
  { re: /^\/isp\/(payments|cashier-close)(\/|$)/, perms: ['sales', 'invoices', 'finance'] },
  { re: /^\/isp\/finance(\/|$)/, perms: ['sales', 'invoices', 'finance'] },
  // Pushing config to a customer's router is a network action, not a billing one.
  { re: /^\/isp\/subscribers\/\d+\/cpe(\/|$)/, perms: ['network', 'tech-tools'] },
  { re: /^\/isp(\/|$)/, perms: ['pppoe'] },
  // TR-069 / GenieACS: same gate the sidebar uses for /cpe-tr069. Without this
  // any authenticated role could repoint the ACS or push parameters to any CPE.
  { re: /^\/acs(\/|$)/, perms: ['network'] },
  { re: /^\/ipoe(\/|$)/, perms: ['ipoe'] },
  { re: /^\/hotspot(\/|$)/, perms: ['hotspot'] },
  { re: /^\/usage(\/|$)/, perms: ['pppoe'] },
  { re: /^\/license(\/|$)/, perms: ['license'] },
  { re: /^\/updater(\/|$)/, perms: ['updater'] },
  { re: /^\/company(\/|$)/, perms: ['company'], writeOnly: true },
  { re: /^\/settings(\/|$)/, perms: ['settings'], writeOnly: true },
  { re: /^\/paymongo(\/|$)/, perms: ['settings', 'sales'] },
  { re: /^\/sync\/(settings|now)/, perms: ['settings'] },
];

/**
 * Which permissions (if any) a request needs. `null` means no rule matched and
 * the request is allowed through to the route by this gate.
 */
export function requiredPermissionsForApiPath(path: string, method = 'GET'): string[] | null {
  const p = String(path || '').split('?')[0].replace(/^\/api/, '') || '/';
  const m = String(method || 'GET').toUpperCase();
  // Merchant partners use /merchant/* with requireCashier — skip the staff gate.
  if (/^\/merchant(\/|$)/.test(p)) return null;
  for (const rule of API_PERMISSION_RULES) {
    if (!rule.re.test(p)) continue;
    if (rule.writeOnly && (m === 'GET' || m === 'HEAD' || m === 'OPTIONS')) return null;
    return rule.perms;
  }
  return null;
}
