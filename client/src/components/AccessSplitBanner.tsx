import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { api } from '../api';

type CompareResult = {
  match: boolean | null;
  message?: string;
  local?: { hostname?: string; nocDevices?: number; pppoeUsers?: number; id?: string };
  remote?: { hostname?: string; nocDevices?: number; pppoeUsers?: number; id?: string } | null;
  remoteUrl?: string | null;
};

/**
 * Warns when Cloudflare hostname and this LAN panel are different machines/DBs.
 * That is the usual reason NOC / Dashboard look different on LAN vs tunnel.
 */
export default function AccessSplitBanner() {
  const [result, setResult] = useState<CompareResult | null>(null);
  const [checking, setChecking] = useState(false);

  const check = () => {
    setChecking(true);
    api
      .get('/access/compare', { timeout: 15000 })
      .then((r) => setResult(r.data))
      .catch(() => setResult(null))
      .finally(() => setChecking(false));
  };

  useEffect(() => {
    check();
    const t = window.setInterval(check, 10 * 60 * 1000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!result || result.match !== false) return null;

  return (
    <div className="shrink-0 border-b border-rose-300/50 bg-rose-500/15 px-3 sm:px-6 lg:px-8 py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-start gap-2 min-w-0">
          <AlertTriangle className="text-rose-400 shrink-0 mt-0.5" size={18} />
          <div className="min-w-0 text-sm text-rose-50">
            <b className="text-white">LAN and Cloudflare are different panels.</b>{' '}
            <span className="text-rose-100/90">
              This host <code className="font-mono text-white">{result.local?.hostname || '?'}</code>
              {' '}({result.local?.nocDevices ?? '?'} NOC · {result.local?.pppoeUsers ?? '?'} PPPoE)
              {' '}≠ tunnel{' '}
              <code className="font-mono text-white">{result.remote?.hostname || '?'}</code>
              {' '}({result.remote?.nocDevices ?? '?'} NOC · {result.remote?.pppoeUsers ?? '?'} PPPoE)
              {result.remoteUrl ? (
                <>
                  {' '}via <code className="font-mono text-white">{result.remoteUrl}</code>
                </>
              ) : null}
              . Install Cloudflare Tunnel on the machine that has your full data (or always use that machine’s LAN IP for staff).
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button type="button" className="btn-secondary text-xs py-1.5 px-2" onClick={check} disabled={checking}>
            <RefreshCw size={14} className={checking ? 'animate-spin' : ''} /> Recheck
          </button>
          <Link to="/cloudflare" className="btn-primary text-xs py-1.5 px-2">
            Cloudflare Tunnel
          </Link>
        </div>
      </div>
    </div>
  );
}
