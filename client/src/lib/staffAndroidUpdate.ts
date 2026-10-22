import { Capacitor } from '@capacitor/core';
import { getApiBase, isNativeApp, isNativePortalApp } from '../config';

export type StaffAndroidPublishInfo = {
  applicationId: string;
  versionCode: number;
  versionName: string;
  apkUrl: string | null;
};

const SESSION_DISMISS_KEY = 'mtbilling_update_dismiss_build';

export async function fetchStaffAndroidPublishInfo(): Promise<StaffAndroidPublishInfo | null> {
  const base = getApiBase();
  if (!base.startsWith('http')) return null;
  try {
    const res = await fetch(`${base}/public/staff/android-app`, { method: 'GET' });
    if (!res.ok) return null;
    const data = (await res.json()) as StaffAndroidPublishInfo;
    if (!data || Number(data.versionCode) <= 0) return null;
    return data;
  } catch {
    return null;
  }
}

export async function getInstalledStaffAndroidBuild(): Promise<number> {
  if (!isNativeApp() || isNativePortalApp() || Capacitor.getPlatform() !== 'android') return 0;
  try {
    const { App } = await import('@capacitor/app');
    const info = await App.getInfo();
    const build = Number.parseInt(String(info.build || '0'), 10);
    return Number.isFinite(build) ? build : 0;
  } catch {
    return 0;
  }
}

export function dismissStaffUpdateForSession(serverVersionCode: number) {
  try {
    sessionStorage.setItem(SESSION_DISMISS_KEY, String(serverVersionCode));
  } catch {
    /* ignore */
  }
}

export function isStaffUpdateDismissedForSession(serverVersionCode: number): boolean {
  try {
    return sessionStorage.getItem(SESSION_DISMISS_KEY) === String(serverVersionCode);
  } catch {
    return false;
  }
}

export async function installStaffAndroidApk(apkUrl: string) {
  const { downloadAndInstallAndroidApk } = await import('./androidApkInstall');
  await downloadAndInstallAndroidApk(apkUrl);
}
