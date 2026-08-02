import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export type ThemeId = 'light' | 'dark' | 'onepiece' | 'steampunk' | 'isptech' | 'blueglass' | 'matrix';

export const THEME_IDS: ThemeId[] = ['light', 'dark', 'onepiece', 'steampunk', 'isptech', 'blueglass', 'matrix'];

const STORAGE_KEY = 'mt_theme';
/** Bump to re-apply Matrix Glass default when the panel look changes again. */
const MIGRATION_KEY = 'mt_theme_matrix_v1';
const DEFAULT_THEME: ThemeId = 'matrix';

interface ThemeCtx {
  theme: ThemeId;
  setTheme: (t: ThemeId) => void;
}

const Ctx = createContext<ThemeCtx>({ theme: DEFAULT_THEME, setTheme: () => undefined });

function applyTheme(theme: ThemeId) {
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.colorScheme = theme === 'light' ? 'light' : 'dark';
}

function resolveInitialTheme(): ThemeId {
  try {
    const migrated = localStorage.getItem(MIGRATION_KEY);
    if (!migrated) {
      localStorage.setItem(MIGRATION_KEY, '1');
      localStorage.setItem(STORAGE_KEY, DEFAULT_THEME);
      return DEFAULT_THEME;
    }
    const saved = localStorage.getItem(STORAGE_KEY) as ThemeId | null;
    if (saved && THEME_IDS.includes(saved)) return saved;
  } catch {
    /* ignore storage errors */
  }
  return DEFAULT_THEME;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>(() => resolveInitialTheme());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = useCallback((t: ThemeId) => {
    setThemeState(t);
    try {
      localStorage.setItem(STORAGE_KEY, t);
      localStorage.setItem(MIGRATION_KEY, '1');
    } catch {
      /* ignore */
    }
    applyTheme(t);
  }, []);

  return <Ctx.Provider value={{ theme, setTheme }}>{children}</Ctx.Provider>;
}

export const useTheme = () => useContext(Ctx);
