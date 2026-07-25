import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, publicApi } from '../api';
import { useAuth } from './AuthContext';

export interface CompanyBrand {
  name: string;
  logo: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
}

interface CompanyCtx {
  company: CompanyBrand | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

const Ctx = createContext<CompanyCtx>({
  company: null,
  loading: true,
  refresh: async () => undefined,
});

const DEFAULTS: CompanyBrand = {
  name: 'ts0gs',
  logo: '/logo.png',
};

export function CompanyProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [company, setCompany] = useState<CompanyBrand | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const token = localStorage.getItem('mt_token');
      if (token) {
        try {
          const r = await api.get('/company');
          const c = r.data || {};
          setCompany({
            name: c.name || DEFAULTS.name,
            logo: c.logo || DEFAULTS.logo,
            address: c.address || null,
            phone: c.phone || null,
            email: c.email || null,
          });
          return;
        } catch {
          /* fall through to public */
        }
      }
      const r = await publicApi.get('/company/branding');
      const c = r.data || {};
      setCompany({
        name: c.name || DEFAULTS.name,
        logo: c.logo || DEFAULTS.logo,
        address: c.address || null,
      });
    } catch {
      setCompany(DEFAULTS);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, user]);

  return <Ctx.Provider value={{ company, loading, refresh }}>{children}</Ctx.Provider>;
}

export function useCompany() {
  return useContext(Ctx);
}
