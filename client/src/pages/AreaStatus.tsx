import { useEffect, useState } from 'react';
import { publicApi } from '../api';

export default function AreaStatus() {
  const [data, setData] = useState<{ branch: string; outages: any[]; updatedAt: string } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    publicApi
      .get('/public/area-status')
      .then((r) => setData(r.data))
      .catch(() => setError('Status page is unavailable.'));
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 text-white px-4 py-10">
      <div className="max-w-lg mx-auto">
        <p className="text-xs uppercase tracking-widest text-emerald-300">Service status</p>
        <h1 className="text-2xl font-semibold mt-1">{data?.branch || 'ISP'} network</h1>
        <p className="text-sm text-white/60 mt-2">Areas we already know are under repair. If your area is not listed, the fault is likely at your premises.</p>
        {error && <p className="text-rose-300 mt-4">{error}</p>}
        {data && data.outages.length === 0 && <p className="mt-6 text-emerald-300">No area outages posted.</p>}
        <ul className="mt-6 space-y-3">
          {(data?.outages || []).map((o) => (
            <li key={o.id} className="rounded-xl border border-white/10 bg-white/5 p-4">
              <div className="font-medium">{o.title}</div>
              <div className="text-sm text-white/70 mt-1">{o.detail || 'Crew is on the way.'}</div>
              <div className="text-xs text-white/40 mt-2">
                {o.nap_name || 'Area'}{o.pon ? ` · PON ${o.pon}` : ''}{o.eta ? ` · ETA ${o.eta}` : ''}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
