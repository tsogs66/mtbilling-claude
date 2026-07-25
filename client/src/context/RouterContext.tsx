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

export function RouterProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [routers, setRouters] = useState<RouterDevice[]>([]);
  const [current, setCurrent] = useState<RouterDevice | null>(null);

  const refresh = () => {
    const token = localStorage.getItem('mt_token');
    if (!token) return;
    api.get('/routers').then((r) => {
      const list: RouterDevice[] = r.data || [];
      setRouters(list);
      setCurrent((prev) => {
        if (list.length === 0) return null;
        const still = prev ? list.find((x) => x.id === prev.id) : undefined;
        return still || list[0];
      });
    });
  };

  // Reload routers whenever the authenticated user changes (incl. right after
  // login), and clear them on logout so the selector reflects auth state.
  useEffect(() => {
    if (user) {
      refresh();
    } else {
      setRouters([]);
      setCurrent(null);
    }
  }, [user]);

  return (
    <Ctx.Provider value={{ routers, current, setCurrent, refresh }}>{children}</Ctx.Provider>
  );
}

export const useRouterDevice = () => useContext(Ctx);
