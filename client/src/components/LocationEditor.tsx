import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { MapContainer, TileLayer, Marker, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import { Search, LocateFixed, X, MapPin } from 'lucide-react';
import { api } from '../api';
import { FALLBACK_MAP_CENTER, normalizeMapCenter } from '../lib/mapDefaults';

export const DEFAULT_PIN: [number, number] = FALLBACK_MAP_CENTER;

/**
 * Tip-accurate teardrop pin.
 * Do NOT combine CSS translate(-50%,-100%) with iconAnchor — that double-offsets
 * the tip away from the true lat/lng (Topology picker stays accurate because it
 * uses a centered icon with matching iconAnchor).
 */
const pinIcon = L.divIcon({
  className: 'loc-pin',
  html: `<svg width="30" height="42" viewBox="0 0 24 34" xmlns="http://www.w3.org/2000/svg" style="display:block">
    <path d="M12 0C5.4 0 0 5.4 0 12c0 8.5 12 22 12 22s12-13.5 12-22C24 5.4 18.6 0 12 0z" fill="#ea580c"/>
    <circle cx="12" cy="12" r="5" fill="#fff"/></svg>`,
  iconSize: [30, 42],
  iconAnchor: [15, 42],
});

function ClickHandler({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onPick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

function Recenter({ pos }: { pos: [number, number] }) {
  const map = useMap();
  useEffect(() => {
    map.setView(pos, map.getZoom());
  }, [map, pos]);
  return null;
}

/** Modal maps often init at 0×0; without this, click→latlng is wrong. */
function MapInvalidateSize() {
  const map = useMap();
  useEffect(() => {
    const t1 = window.setTimeout(() => map.invalidateSize(), 80);
    const t2 = window.setTimeout(() => map.invalidateSize(), 250);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [map]);
  return null;
}

export default function LocationEditor({
  initial,
  onDone,
  onCancel,
}: {
  initial?: { lat: number | null; lng: number | null };
  onDone: (coords: { lat: number; lng: number }) => void;
  onCancel: () => void;
}) {
  const start: [number, number] =
    initial?.lat != null && initial?.lng != null ? [initial.lat, initial.lng] : DEFAULT_PIN;
  const [pos, setPos] = useState<[number, number]>(start);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ displayName: string; lat: number; lon: number }[]>([]);
  const [searching, setSearching] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (initial?.lat != null && initial?.lng != null) return;
    let cancelled = false;
    api
      .get('/map/default-center')
      .then((r) => {
        if (cancelled) return;
        const c = normalizeMapCenter(r.data?.lat, r.data?.lng);
        setPos([c.lat, c.lng]);
      })
      .catch(() => {
        /* keep FALLBACK_MAP_CENTER */
      });
    return () => {
      cancelled = true;
    };
  }, [initial?.lat, initial?.lng]);

  const setLat = (v: string) => setPos(([, lng]) => [v === '' ? 0 : Number(v), lng]);
  const setLng = (v: string) => setPos(([lat]) => [lat, v === '' ? 0 : Number(v)]);

  const pick = (lat: number, lng: number) =>
    setPos([Number(lat.toFixed(8)), Number(lng.toFixed(8))]);

  const search = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setMsg('');
    setResults([]);
    try {
      const r = await api.get(`/geocode?q=${encodeURIComponent(query)}`);
      if (!r.data.length) setMsg('No results found.');
      setResults(r.data);
      if (r.data[0]) setPos([r.data[0].lat, r.data[0].lon]);
    } catch {
      setMsg('Search is unavailable right now.');
    } finally {
      setSearching(false);
    }
  };

  const useCurrent = () => {
    if (!navigator.geolocation) {
      setMsg('Geolocation is not supported by this browser.');
      return;
    }
    setMsg('Locating…');
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setPos([p.coords.latitude, p.coords.longitude]);
        setMsg('');
      },
      () => setMsg('Unable to get current location (permission denied).'),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  };

  return createPortal(
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[2100] p-4" style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0 }} role="presentation">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto" role="dialog" aria-modal="true" aria-label="Set Map Location">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
          <h3 className="font-semibold text-slate-700 flex items-center gap-2"><MapPin size={18} className="text-brand-600" /> Set Map Location</h3>
          <button type="button" onClick={onCancel} className="text-slate-400 hover:text-slate-600" aria-label="Close"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex-1 min-w-[180px]">
              <label className="text-xs text-slate-500 mb-1 block">Search address (OpenStreetMap)</label>
              <div className="relative">
                <Search size={15} className="absolute left-2.5 top-2.5 text-slate-400" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && search()}
                  placeholder="e.g. Batangas City"
                  className="input pl-8"
                />
              </div>
            </div>
            <button className="px-4 py-2 text-sm rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-600" onClick={search} disabled={searching}>
              {searching ? 'Searching…' : 'Search'}
            </button>
            <button className="inline-flex items-center gap-2 px-3 py-2 text-sm rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-600" onClick={useCurrent}>
              <LocateFixed size={15} /> Use Current Location
            </button>
          </div>

          {results.length > 1 && (
            <div className="max-h-28 overflow-y-auto border border-slate-100 rounded-lg text-sm">
              {results.map((r, i) => (
                <button
                  key={i}
                  onClick={() => setPos([r.lat, r.lon])}
                  className="block w-full text-left px-3 py-1.5 hover:bg-slate-50 truncate"
                  title={r.displayName}
                >
                  {r.displayName}
                </button>
              ))}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-slate-500 mb-1 block">Latitude</label>
              <input className="input" value={pos[0]} onChange={(e) => setLat(e.target.value)} />
            </div>
            <div>
              <label className="text-xs text-slate-500 mb-1 block">Longitude</label>
              <input className="input" value={pos[1]} onChange={(e) => setLng(e.target.value)} />
            </div>
          </div>

          {msg && <div className="text-xs text-slate-500">{msg}</div>}

          <div className="h-72 rounded-lg overflow-hidden border border-slate-100 relative">
            <MapContainer
              key="user-location-editor"
              center={start}
              zoom={17}
              minZoom={3}
              maxZoom={22}
              style={{ height: '100%', width: '100%' }}
              scrollWheelZoom
            >
              <TileLayer
                attribution="&copy; OpenStreetMap contributors"
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                maxZoom={22}
                maxNativeZoom={19}
              />
              <MapInvalidateSize />
              <Recenter pos={pos} />
              <ClickHandler onPick={pick} />
              <Marker
                position={pos}
                icon={pinIcon}
                draggable
                eventHandlers={{
                  dragend: (e) => {
                    const m = e.target as L.Marker;
                    const ll = m.getLatLng();
                    pick(ll.lat, ll.lng);
                  },
                }}
              />
            </MapContainer>
            <div className="absolute top-2 left-2 z-[500] bg-white/95 text-[11px] text-slate-600 px-2 py-1 rounded border border-slate-200 shadow-sm pointer-events-none">
              Click map to place pin
            </div>
          </div>
          <p className="text-[11px] text-slate-400">Click the map or drag the pin to set the exact location.</p>
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-100">
          <button className="px-4 py-2 text-sm rounded-lg text-slate-600 hover:bg-slate-100" onClick={onCancel}>Cancel</button>
          <button className="btn-primary" onClick={() => onDone({ lat: Number(pos[0]), lng: Number(pos[1]) })}>Done</button>
        </div>
      </div>
      <style>{`
        .loc-pin {
          background: transparent !important;
          border: none !important;
        }
      `}</style>
    </div>,
    document.body
  );
}
