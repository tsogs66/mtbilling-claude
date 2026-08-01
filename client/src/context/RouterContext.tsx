import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import { useAuth } from './AuthContext';

export interface RouterDevice {
  id: number;
  name: string;
  host: string;
  board: string;
  type: string;
  status: string;
}

interface RouterCtx {
  routers: RouterDevice[];
  current: RouterDevice | null;
  setCurrent: (r: RouterDevice) => void;
  refresh: () => void;
}

const Ctx = createContext<RouterCtx>(null as unknown as RouterCtx);

const ACTIVE_ROUTER_KEY = 'mt_active_router_id';

function readStoredRouterId(): number | null {
  try {
    const raw = localStorage.getItem(ACTIVE_ROUTER_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [routers, setRouters] = useState<RouterDevice[]>([]);
  const [current, setCurrentState] = useState<RouterDevice | null>(null);

  const setCurrent = (r: RouterDevice) => {
    setCurrentState(r);
    try {
      localStorage.setItem(ACTIVE_ROUTER_KEY, String(r.id));
    } catch {
      /* ignore */
    }
  };

  const refresh = () => {
    const token = localStorage.getItem('mt_token');
    if (!token) return;
    api.get('/routers', { timeout: 8000 }).then((r) => {
      const list: RouterDevice[] = r.data || [];
      setRouters(list);
      setCurrentState((prev) => {
        if (list.length === 0) return null;
        const storedId = readStoredRouterId();
        const byStored = storedId != null ? list.find((x) => x.id === storedId) : undefined;
        const still = prev ? list.find((x) => x.id === prev.id) : undefined;
        const next = byStored || still || list[0];
        if (next) {
          try {
            localStorage.setItem(ACTIVE_ROUTER_KEY, String(next.id));
          } catch {
            /* ignore */
          }
        }
        return next;
      });
    }).catch(() => {
      /* keep last-known routers — never hang the shell */
    });
  };

  // Reload routers whenever the authenticated user changes (incl. right after
  // login), and clear them on logout so the selector reflects auth state.
  useEffect(() => {
    if (user) {
      refresh();
    } else {
      setRouters([]);
      setCurrentState(null);
    }
  }, [user]);

  return (
    <Ctx.Provider value={{ routers, current, setCurrent, refresh }}>{children}</Ctx.Provider>
  );
}

export const useRouterDevice = () => useContext(Ctx);
