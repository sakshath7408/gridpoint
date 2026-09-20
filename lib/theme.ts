'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Theme } from './palette';

const KEY = 'gridpoint-theme';

/**
 * Theme state, persisted per viewer.
 *
 * Dark is the default and the product's identity — a viewer who has never
 * touched the toggle gets dark regardless of their OS setting. The choice is
 * kept in localStorage, which can throw (private windows, blocked site data)
 * and can come back empty, so every access is guarded and the app renders
 * correctly without it.
 *
 * `data-theme` is written on <html> by an inline script in layout.tsx BEFORE
 * first paint, so there is no flash of the wrong theme. This hook only keeps
 * React in sync with what that script already decided.
 */
export function useTheme(): [Theme, (t: Theme) => void, () => void] {
  const [theme, setThemeState] = useState<Theme>('dark');

  useEffect(() => {
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'light' || attr === 'dark') setThemeState(attr);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    document.documentElement.setAttribute('data-theme', t);
    document.documentElement.style.colorScheme = t;
    try { localStorage.setItem(KEY, t); } catch { /* storage unavailable — session-only */ }
  }, []);

  const toggle = useCallback(() => {
    setThemeState((cur) => {
      const next: Theme = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      document.documentElement.style.colorScheme = next;
      try { localStorage.setItem(KEY, next); } catch { /* ignore */ }
      return next;
    });
  }, []);

  return [theme, setTheme, toggle];
}

/**
 * Runs before first paint, inlined into <head>. Must stay tiny and
 * dependency-free — it is stringified into the document.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem('${KEY}');if(t!=='light'&&t!=='dark')t='dark';document.documentElement.setAttribute('data-theme',t);document.documentElement.style.colorScheme=t;}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`;
