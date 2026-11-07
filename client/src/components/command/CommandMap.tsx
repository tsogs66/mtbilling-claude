import { useEffect, useMemo, useRef } from 'react';
import { CircleMarker, MapContainer, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import { Crosshair } from 'lucide-react';
import { categoryOf, LENS_CATEGORIES, type CcSubscriber, type Lens, type Tone } from '../../lib/commandModel';

export const TONE_HEX: Record<Tone, string> = {
  good: '#10b981',
  warn: '#f59e0b',
  bad: '#ef4444',
  info: '#38bdf8',
  mute: '#94a3b8',
  hot: '#f97316',
};

type Bounds = [number, number, number, number];

function FitOnce({ points }: { points: [number, number][] }) {
  const map = useMap();
  const done = useRef(false);
  useEffect(() => {
    if (done.current || points.length === 0) return;
    done.current = true;
    map.fitBounds(L.latLngBounds(points), { padding: [36, 36], maxZoom: 17 });
  }, [map, points]);
  return null;
}

function ViewWatcher({ follow, onBounds }: { follow: boolean; onBounds: (b: Bounds | null) => void }) {
  const map = useMapEvents({
    moveend: () => {
      if (!follow) return;
      const b = map.getBounds();
      onBounds([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()]);
    },
  });
  useEffect(() => {
    if (follow) {
      const b = map.getBounds();
      onBounds([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()]);
    } else {
      onBounds(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [follow]);
  return null;
}

function FitButton({ points }: { points: [number, number][] }) {
  const map = useMap();
  return (
    <button
      type="button"
      className="cc-map-btn"
      title="Fit the map to the subscribers shown"
      disabled={points.length === 0}
      onClick={() => points.length && map.fitBounds(L.latLngBounds(points), { padding: [36, 36], maxZoom: 17 })}
    >
      <Crosshair size={14} /> Fit
    </button>
  );
}

export default function CommandMap({
  all,
  shown,
  lens,
  selectedId,
  follow,
  onSelect,
  onBounds,
}: {
  all: CcSubscriber[];
  shown: CcSubscriber[];
  lens: Lens;
  selectedId: number | null;
  follow: boolean;
  onSelect: (id: number) => void;
  onBounds: (b: Bounds | null) => void;
}) {
  const cats = LENS_CATEGORIES[lens];
  const toneOf = (s: CcSubscriber) => cats.find((c) => c.key === categoryOf(s, lens))?.tone ?? 'mute';

  const located = useMemo(() => all.filter((s) => s.lat != null && s.lng != null), [all]);
  const allPoints = useMemo(() => located.map((s) => [s.lat as number, s.lng as number] as [number, number]), [located]);
  const shownIds = useMemo(() => new Set(shown.map((s) => s.id)), [shown]);
  const shownPoints = useMemo(
    () => shown.filter((s) => s.lat != null && s.lng != null).map((s) => [s.lat as number, s.lng as number] as [number, number]),
    [shown]
  );

  const center: [number, number] = allPoints[0] || [14.5995, 120.9842];

  return (
    <div className="cc-map relative h-full w-full">
      <MapContainer center={center} zoom={14} preferCanvas zoomControl scrollWheelZoom className="h-full w-full cc-leaflet" attributionControl>
        <TileLayer attribution="&copy; OpenStreetMap" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" maxZoom={19} />
        <FitOnce points={allPoints} />
        <ViewWatcher follow={follow} onBounds={onBounds} />
        {located
          .filter((s) => !shownIds.has(s.id))
          .map((s) => (
            <CircleMarker
              key={`dim-${s.id}`}
              center={[s.lat as number, s.lng as number]}
              radius={3}
              interactive={false}
              pathOptions={{ color: '#64748b', weight: 0, fillColor: '#64748b', fillOpacity: 0.28 }}
            />
          ))}
        {located
          .filter((s) => shownIds.has(s.id))
          .map((s) => {
            const color = TONE_HEX[toneOf(s)];
            const picked = s.id === selectedId;
            return (
              <CircleMarker
                key={`on-${s.id}`}
                center={[s.lat as number, s.lng as number]}
                radius={picked ? 10 : lens === 'risk' ? 4 + Math.round(s.risk / 20) : 6}
                eventHandlers={{ click: () => onSelect(s.id) }}
                pathOptions={{
                  color: picked ? '#ffffff' : color,
                  weight: picked ? 3 : 1.5,
                  fillColor: color,
                  fillOpacity: picked ? 1 : 0.85,
                }}
              >
                <Tooltip direction="top" offset={[0, -6]}>
                  <strong>{s.name}</strong>
                  <br />
                  {s.plan}
                </Tooltip>
              </CircleMarker>
            );
          })}
        <div className="leaflet-top leaflet-right">
          <div className="leaflet-control cc-map-ctl">
            <FitButton points={shownPoints} />
          </div>
        </div>
      </MapContainer>
    </div>
  );
}
