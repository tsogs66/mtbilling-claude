import { useEffect, useState } from 'react';
import { Download, Sparkles, X } from 'lucide-react';
import {
  dismissPortalUpdateForSession,
  fetchPortalAndroidPublishInfo,
  getInstalledPortalAndroidBuild,
  isPortalUpdateDismissedForSession,
  openPortalAndroidApkUrl,
  type PortalAndroidPublishInfo,
} from '../../lib/portalAndroidUpdate';
import { isNativePortalApp } from '../../config';

/**
 * On PANORTH Android app launch, compare installed versionCode with the panel-published APK.
 * Same applicationId (com.tsogs.panorth) allows in-place upgrade when the user installs the new APK.
 */
export default function PortalAndroidUpdateGate() {
  const [info, setInfo] = useState<PortalAndroidPublishInfo | null>(null);
  const [installed, setInstalled] = useState(0);

  useEffect(() => {
    if (!isNativePortalApp()) return;
    let cancelled = false;
    void (async () => {
      const [pub, build] = await Promise.all([
        fetchPortalAndroidPublishInfo(),
        getInstalledPortalAndroidBuild(),
      ]);
      if (cancelled) return;
      setInstalled(build);
      if (!pub || !pub.apkUrl || pub.versionCode <= build) return;
      if (isPortalUpdateDismissedForSession(pub.versionCode)) return;
      setInfo(pub);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!info?.apkUrl || info.versionCode <= installed) return null;

  const later = () => {
    dismissPortalUpdateForSession(info.versionCode);
    setInfo(null);
  };

  const update = () => {
    void openPortalAndroidApkUrl(info.apkUrl!);
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-end sm:items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div
        className="w-full max-w-md rounded-2xl border border-emerald-500/30 bg-[#041510]/95 shadow-2xl p-5 text-white"
        role="dialog"
        aria-labelledby="panorth-update-title"
      >
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-center gap-2">
            <Sparkles className="text-emerald-400 shrink-0" size={22} />
            <h2 id="panorth-update-title" className="text-lg font-semibold tracking-tight">
              PANORTH update available
            </h2>
          </div>
          <button
            type="button"
            onClick={later}
            className="p-1 rounded-lg text-white/60 hover:text-white hover:bg-white/10"
            aria-label="Dismiss"
          >
            <X size={18} />
          </button>
        </div>
        <p className="text-sm text-white/80 leading-relaxed">
          A newer version of PANORTH is ready (
          <span className="font-medium text-emerald-300">{info.versionName}</span>
          ). You can install it on top of this app — no need to uninstall first.
        </p>
        <p className="text-xs text-white/50 mt-2">
          Installed build {installed} → available build {info.versionCode}
        </p>
        <div className="flex flex-col sm:flex-row gap-2 mt-5">
          <button
            type="button"
            onClick={update}
            className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold py-2.5 px-4 text-sm"
          >
            <Download size={18} />
            Download update
          </button>
          <button
            type="button"
            onClick={later}
            className="flex-1 rounded-xl border border-white/20 py-2.5 px-4 text-sm text-white/80 hover:bg-white/5"
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
