import { useEffect, useState } from 'react';
import { Download, Smartphone, X } from 'lucide-react';
import {
  dismissStaffUpdateForSession,
  fetchStaffAndroidPublishInfo,
  getInstalledStaffAndroidBuild,
  installStaffAndroidApk,
  isStaffUpdateDismissedForSession,
  type StaffAndroidPublishInfo,
} from '../lib/staffAndroidUpdate';
import { isNativeApp, isNativePortalApp } from '../config';

export default function StaffAndroidUpdateGate() {
  const [info, setInfo] = useState<StaffAndroidPublishInfo | null>(null);
  const [installed, setInstalled] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isNativeApp() || isNativePortalApp()) return;
    let cancelled = false;
    void (async () => {
      const [pub, build] = await Promise.all([
        fetchStaffAndroidPublishInfo(),
        getInstalledStaffAndroidBuild(),
      ]);
      if (cancelled) return;
      setInstalled(build);
      if (!pub || !pub.apkUrl || pub.versionCode <= build) return;
      if (isStaffUpdateDismissedForSession(pub.versionCode)) return;
      setInfo(pub);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!info?.apkUrl || info.versionCode <= installed) return null;

  const later = () => {
    dismissStaffUpdateForSession(info.versionCode);
    setInfo(null);
  };

  const update = () => {
    setBusy(true);
    setError('');
    void installStaffAndroidApk(info.apkUrl!)
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'Install failed');
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-end sm:items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-brand-500/30 bg-slate-900/95 shadow-2xl p-5 text-white">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-center gap-2">
            <Smartphone className="text-brand-400 shrink-0" size={22} />
            <h2 className="text-lg font-semibold">MT-Billing update available</h2>
          </div>
          <button type="button" onClick={later} className="p-1 rounded-lg text-white/60 hover:text-white hover:bg-white/10" aria-label="Dismiss">
            <X size={18} />
          </button>
        </div>
        <p className="text-sm text-white/80 leading-relaxed">
          Version <span className="font-medium text-brand-300">{info.versionName}</span> is ready. Install on top of
          this app — no uninstall needed (build {installed} → {info.versionCode}).
        </p>
        {error ? <p className="text-xs text-rose-300 mt-2">{error}</p> : null}
        <div className="flex flex-col sm:flex-row gap-2 mt-5">
          <button
            type="button"
            onClick={update}
            disabled={busy}
            className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-brand-500 hover:bg-brand-400 text-slate-950 font-semibold py-2.5 px-4 text-sm disabled:opacity-60"
          >
            <Download size={18} />
            {busy ? 'Downloading…' : 'Install update'}
          </button>
          <button type="button" onClick={later} className="flex-1 rounded-xl border border-white/20 py-2.5 px-4 text-sm text-white/80 hover:bg-white/5">
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
