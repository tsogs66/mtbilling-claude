/**
 * Runtime config for web vs Capacitor (Android/iOS) builds.
 * Native apps must talk to the public panel HTTPS URL — there is no Vite /api proxy.
 */
import { Capacitor } from '@capacitor/core';

const STORAGE_KEY = 'mt_server_url';

export function isNativeApp() {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

/** Normalize user-entered panel URL → origin without trailing slash. */
export function normalizeServerUrl(raw: string): string {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  // Drop path like /login so we always hit the API root host
  return u.origin;
}

export function getStoredServerUrl(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function setStoredServerUrl(url: string) {
  const normalized = normalizeServerUrl(url);
  if (!normalized) {
    localStorage.removeItem(STORAGE_KEY);
    return '';
  }
  localStorage.setItem(STORAGE_KEY, normalized);
  return normalized;
}

/**
 * Build-time override: `VITE_API_BASE=https://panel.example.com npm run build`
 * Runtime override (native): localStorage `mt_server_url`
 * Browser (web): relative `/api` via Vite proxy or same-origin deploy.
 */
export function getApiBase(): string {
  const envBase = String(import.meta.env.VITE_API_BASE || '').trim();
  if (envBase) {
    const origin = normalizeServerUrl(envBase);
    return `${origin}/api`;
  }
  if (isNativeApp()) {
    const stored = getStoredServerUrl();
    if (stored) return `${stored}/api`;
    // Placeholder until ServerSetup saves a URL — requests will fail clearly
    return '/api';
  }
  return '/api';
}

export function getHttpOrigin(): string {
  const base = getApiBase();
  if (base.startsWith('http')) {
    return base.replace(/\/api\/?$/, '');
  }
  return window.location.origin;
}

/** WebSocket base for terminal (ws/wss + host). */
export function getWsUrl(path: string): string {
  const origin = getHttpOrigin();
  if (origin.startsWith('http')) {
    const u = new URL(origin);
    const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${u.host}${path.startsWith('/') ? path : `/${path}`}`;
  }
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${path.startsWith('/') ? path : `/${path}`}`;
}

export function needsServerSetup(): boolean {
  if (!isNativeApp()) return false;
  if (String(import.meta.env.VITE_API_BASE || '').trim()) return false;
  return !getStoredServerUrl();
}
