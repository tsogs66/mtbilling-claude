import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export type ThemeId = 'light' | 'dark' | 'onepiece';

const STORAGE_KEY = 'mt_theme';

interface ThemeCtx {
  theme: ThemeId;
  setTheme: (t: ThemeId) => void;
}

const Ctx = createContext<ThemeCtx>({ theme: 'light', setTheme: () => undefined });

function applyTheme(theme: ThemeId) {
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.colorScheme = theme === 'light' ? 'light' : 'dark';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>(() => {
    const saved = localStorage.getItem(STORAGE_KEY) as ThemeId | null;
    if (saved === 'light' || saved === 'dark' || saved === 'onepiece') return saved;
    return 'light';
  });

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = useCallback((t: ThemeId) => {
    setThemeState(t);
    localStorage.setItem(STORAGE_KEY, t);
    applyTheme(t);
  }, []);

  return <Ctx.Provider value={{ theme, setTheme }}>{children}</Ctx.Provider>;
}

export const useTheme = () => useContext(Ctx);
