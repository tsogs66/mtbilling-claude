import { useState } from 'react';
import { Server, ArrowRight, Loader2, Shield } from 'lucide-react';
import { normalizeServerUrl, setStoredServerUrl } from '../config';
import { BRAND_SHORT, PRODUCT_TITLE } from '../branding';
import Logo from '../components/Logo';

/**
 * First-launch gate for the Capacitor Android/iOS app:
 * user enters the public panel URL (e.g. https://billing.example.com).
 */
export default function ServerSetup({ onReady }: { onReady: () => void }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    let origin = '';
    try {
      origin = normalizeServerUrl(url);
    } catch {
      setError('Enter a valid URL, e.g. https://billing.yourdomain.com');
      return;
    }
    if (!origin) {
      setError('Panel URL is required');
      return;
    }

    setBusy(true);
    try {
      // Probe before persisting so a bad URL does not skip this screen on next launch.
      const res = await fetch(`${origin}/api/health`, { method: 'GET' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStoredServerUrl(origin);
      onReady();
    } catch {
      setError(
        'Could not reach the panel API. Check the URL, HTTPS certificate, and that /api/health is publicly reachable.'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-slate-950 px-4 py-8 relative overflow-hidden">
      <div className="absolute inset-0 bg-mesh-dark opacity-80" />
      <div className="relative z-10 w-full max-w-md">
        <div className="flex justify-center mb-6">
          <Logo size="hero" brandMode variant="dark" className="items-center gap-3" />
        </div>
        <div className="bg-white/95 backdrop-blur-xl rounded-3xl shadow-2xl border border-white/20 p-6 sm:p-8">
          <div className="mb-6">
            <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
              <Server size={22} className="text-brand-500" />
              Connect panel
            </h1>
            <p className="text-sm text-slate-500 mt-1 leading-relaxed">
              Enter your MT-Billing public address (same hostname you open in a browser). The app will use it for API calls.
            </p>
          </div>

          <form onSubmit={save} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5" htmlFor="panel-url">
                Panel URL
              </label>
              <input
                id="panel-url"
                className="input text-base"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://billing.example.com"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                inputMode="url"
                autoFocus
              />
            </div>

            {error && (
              <div className="text-sm text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-4 py-3">{error}</div>
            )}

            <button type="submit" disabled={busy || !url.trim()} className="btn-primary w-full py-3 text-base min-h-12">
              {busy ? (
                <Loader2 size={18} className="animate-spin" />
              ) : (
                <>
                  Continue
                  <ArrowRight size={18} />
                </>
              )}
            </button>
          </form>

          <p className="text-[11px] text-slate-400 mt-6 text-center leading-relaxed flex items-start justify-center gap-1.5">
            <Shield size={12} className="mt-0.5 shrink-0" />
            <span>
              {BRAND_SHORT} · {PRODUCT_TITLE}. Use HTTPS in production.
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}
