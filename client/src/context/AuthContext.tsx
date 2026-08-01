import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, publicApi } from '../api';

export interface User {
  id: number;
  username: string;
  role: string;
  permissions: string[];
  licenseActivated: boolean;
  /** True when UI/API must not mutate (unlicensed or viewer role). */
  readOnly: boolean;
  canWrite: boolean;
}

interface AuthCtx {
  user: User | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<{ requiresTotp: true; pendingToken: string } | { requiresTotp: false }>;
  completeTotpLogin: (pendingToken: string, code: string) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
  /** Menu/route visibility (role-based when licensed; all menus when unlicensed). */
  canAccess: (permission: string) => boolean;
  /** False for unlicensed panels and Read-only / viewer accounts. */
  canWrite: boolean;
}

const Ctx = createContext<AuthCtx>(null as unknown as AuthCtx);

function normalizeUser(raw: any): User {
  const licenseActivated = !!raw.licenseActivated;
  const role = String(raw.role || '');
  const permissions = Array.isArray(raw.permissions) ? raw.permissions.map(String) : ['dashboard', 'license'];
  const roleReadOnly = /^read[\s_-]?only$/i.test(role.trim()) || permissions.includes('readonly');
  const canWrite =
    typeof raw.canWrite === 'boolean' ? !!raw.canWrite : licenseActivated && !roleReadOnly;
  const readOnly = typeof raw.readOnly === 'boolean' ? !!raw.readOnly : !canWrite;
  return {
    id: raw.id,
    username: raw.username,
    role,
    permissions,
    licenseActivated,
    readOnly,
    canWrite,
  };
}

function persistSessionFlags(u: User) {
  localStorage.setItem('mt_licensed', u.licenseActivated ? '1' : '0');
  localStorage.setItem('mt_can_write', u.canWrite ? '1' : '0');
  localStorage.setItem('mt_readonly', u.readOnly ? '1' : '0');
}

function clearSessionFlags() {
  localStorage.removeItem('mt_token');
  localStorage.removeItem('mt_licensed');
  localStorage.removeItem('mt_can_write');
  localStorage.removeItem('mt_readonly');
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('mt_token');
    if (!token) {
      clearSessionFlags();
      setLoading(false);
      return;
    }
    api
      .get('/me')
      .then((r) => {
        // /me may return a refreshed JWT in the body (or X-Mt-Token via interceptor).
        const next = r.data?.token;
        if (
          typeof next === 'string' &&
          next.length >= 40 &&
          next.split('.').length === 3
        ) {
          localStorage.setItem('mt_token', next);
        }
        const u = normalizeUser(r.data.user);
        persistSessionFlags(u);
        setUser(u);
      })
      .catch((err) => {
        // Only clear session on a real API 401 JSON. Network blips, CF edge HTML,
        // and 5xx must not log the operator out while they are working.
        const status = err?.response?.status;
        const ct = String(err?.response?.headers?.['content-type'] || '');
        const data = err?.response?.data;
        const apiError =
          data &&
          typeof data === 'object' &&
          (typeof data.error === 'string' || typeof data.message === 'string');
        const isJson401 = status === 401 && (!ct || /application\/json/i.test(ct)) && apiError;
        if (isJson401) clearSessionFlags();
      })
      .finally(() => setLoading(false));
  }, []);

  const applySession = (data: any) => {
    if (typeof data?.token === 'string' && data.token) {
      localStorage.setItem('mt_token', data.token);
    }
    const u = normalizeUser(data.user);
    persistSessionFlags(u);
    setUser(u);
  };

  const login = async (username: string, password: string) => {
    // Use publicApi so a failed login 401 never clears another active session
    // via the authenticated client's interceptor.
    const r = await publicApi.post('/login', { username, password });
    if (r.data.requiresTotp) {
      return { requiresTotp: true as const, pendingToken: r.data.pendingToken as string };
    }
    applySession(r.data);
    return { requiresTotp: false as const };
  };

  const completeTotpLogin = async (pendingToken: string, code: string) => {
    const r = await publicApi.post('/login/totp', { pendingToken, code });
    applySession(r.data);
  };

  const logout = () => {
    clearSessionFlags();
    setUser(null);
  };

  const refresh = async () => {
    const r = await api.get('/me');
    const u = normalizeUser(r.data.user);
    persistSessionFlags(u);
    setUser(u);
  };

  const canAccess = (permission: string) => {
    if (!user) return false;
    // Unlicensed: show every menu (read-only browsing)
    if (!user.licenseActivated) return true;
    // Viewer / Read-only: full menu visibility
    if (user.readOnly || user.permissions.includes('readonly') || /^read[\s_-]?only$/i.test(user.role)) {
      return true;
    }
    if (user.permissions.includes('*')) return true;
    if (user.permissions.includes(permission)) return true;
    // Routers merged into Network — either permission grants access
    if (permission === 'network' && user.permissions.includes('routers')) return true;
    return false;
  };

  const canWrite = !!user?.canWrite;

  return (
    <Ctx.Provider value={{ user, loading, login, completeTotpLogin, logout, refresh, canAccess, canWrite }}>
      {children}
    </Ctx.Provider>
  );
}

export const useAuth = () => useContext(Ctx);
