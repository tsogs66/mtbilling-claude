import { Capacitor } from '@capacitor/core';
import { ApkInstaller } from './capacitor/apkInstaller';

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = String(reader.result || '');
      const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Download APK and open the system installer (in-place upgrade when versionCode increases). */
export async function downloadAndInstallAndroidApk(apkUrl: string): Promise<void> {
  const url = String(apkUrl || '').trim();
  if (!url) throw new Error('APK URL missing');
  if (Capacitor.getPlatform() !== 'android') {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const blob = await res.blob();
  const base64 = await blobToBase64(blob);

  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const path = `updates/build-${Date.now()}.apk`;
  await Filesystem.writeFile({
    path,
    data: base64,
    directory: Directory.Cache,
  });
  const { uri } = await Filesystem.getUri({
    path,
    directory: Directory.Cache,
  });
  await ApkInstaller.install({ uri });
}
