import { Capacitor } from '@capacitor/core';
import { getApiBase, isNativePortalApp } from '../config';

export type PortalAndroidPublishInfo = {
  applicationId: string;
  versionCode: number;
  versionName: string;
  apkUrl: string | null;
};

const SESSION_DISMISS_KEY = 'panorth_update_dismiss_build';

export async function fetchPortalAndroidPublishInfo(): Promise<PortalAndroidPublishInfo | null> {
  const base = getApiBase();
  if (!base.startsWith('http')) return null;
  try {
    const res = await fetch(`${base}/public/portal/android-app`, { method: 'GET' });
    if (!res.ok) return null;
    const data = (await res.json()) as PortalAndroidPublishInfo;
    if (!data || Number(data.versionCode) <= 0) return null;
    return data;
  } catch {
    return null;
  }
}

export async function getInstalledPortalAndroidBuild(): Promise<number> {
  if (!isNativePortalApp() || Capacitor.getPlatform() !== 'android') return 0;
  try {
    const { App } = await import('@capacitor/app');
    const info = await App.getInfo();
    const build = Number.parseInt(String(info.build || '0'), 10);
    return Number.isFinite(build) ? build : 0;
  } catch {
    return 0;
  }
}

export function dismissPortalUpdateForSession(serverVersionCode: number) {
  try {
    sessionStorage.setItem(SESSION_DISMISS_KEY, String(serverVersionCode));
  } catch {
    /* ignore */
  }
}

export function isPortalUpdateDismissedForSession(serverVersionCode: number): boolean {
  try {
    return sessionStorage.getItem(SESSION_DISMISS_KEY) === String(serverVersionCode);
  } catch {
    return false;
  }
}

export async function openPortalAndroidApkUrl(apkUrl: string) {
  const url = String(apkUrl || '').trim();
  if (!url) return;
  try {
    const { Browser } = await import('@capacitor/browser');
    await Browser.open({ url });
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
