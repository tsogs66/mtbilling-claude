import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, Polyline, Popup, Tooltip as LTooltip, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import { Search, SlidersHorizontal, Maximize2, Plus, Server, X, Route, MapPin, Undo2, Sparkles } from 'lucide-react';
import Layout from '../components/Layout';
import { Modal, ModalFooter, FormField } from '../components/ui';
import { api } from '../api';
import { useRouterDevice } from '../context/RouterContext';
import { FALLBACK_MAP_LAT, FALLBACK_MAP_LNG, normalizeMapCenter } from '../lib/mapDefaults';
import { fetchCurrentWeather, weatherCategory, type WeatherNow, type WeatherCategory } from '../lib/weather';
import { computeNapChainDbm, resolveSplitterInputDbm, isAsymmetricType, ratioLegLabel, type ChainNapLike, type SplitterRefLike, type SplitterLike } from '../lib/opticalBudget';

interface ServerNode {
  id: number; name: string; host?: string; status: string;
  lat: number; lng: number; address?: string;
}
interface Nap {
  id: number; name: string; kind: string; lat: number; lng: number; ports: number;
  usedPorts?: number; availablePorts?: number;
  parentId: number | null; code?: string | null; status?: string; address?: string | null;
  splitterRatio?: string | null; splitterType?: 'FBT' | 'PLC' | 'FBTC' | null; fbtcLeg?: 'through' | 'tap' | null; txDbm?: number | null;
  originSplitterId?: number | null;
  ponPort?: number | null;
  host?: string | null; vendor?: string | null; model?: string | null; sysName?: string | null;
  firmware?: string | null; lastProbeAt?: string | null; probeError?: string | null;
}
interface Splitter {
  id: number; name: string; type: 'FBT' | 'PLC' | 'FBTC'; ratio: string; ports?: number | null;
  originKind: 'olt' | 'nap' | 'splitter'; originId: number | null; fbtcLeg?: 'through' | 'tap' | null;
}
interface Connector { id: number; kind: string; fromId: number; toId: number; points: [number, number][] }
interface Client {
  id: number; username: string; customer: string; status: string; online: boolean;
  lat: number; lng: number; napId: number; routerId?: number; service: string; address?: string;
  account?: string; plan?: string; due?: string; napName?: string; oltName?: string;
  serverName?: string; upstreamPort?: number; plcPort?: number;
  rxBps?: number; txBps?: number; rxGB?: number; txGB?: number; topology?: string;
}

type ClientState = 'online' | 'offline' | 'expired' | 'non-payment' | 'disabled';
type RouteKind = 'server-olt' | 'olt-nap' | 'nap-nap' | 'nap-client';

function fmtRate(bps?: number): string {
  const v = bps || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)} Mbps`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(2)} Kbps`;
  return `${Math.round(v)} bps`;
}
function fmtGB(gb?: number): string {
  const v = gb || 0;
  return `${v >= 100 ? v.toFixed(1) : v.toFixed(2)} GB`;
}

/** Physical FBTC cassette tray sizes — a client NAP running FBTC must use one of these. */
const FBTC_PORT_OPTIONS = [8, 16, 32];

/** Distinct ratio strings available for a splitter type, in reference-table order. */
function splitterRatioOptions(rows: SplitterRefLike[], type: 'FBT' | 'PLC' | 'FBTC'): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    if (r.type !== type || seen.has(r.ratio)) continue;
    seen.add(r.ratio);
    out.push(r.ratio);
  }
  return out;
}

function clientState(c: Client): ClientState {
  const s = (c.status || '').toLowerCase().replace(/\s+/g, '-');
  if (s === 'expired') return 'expired';
  if (s === 'non-payment' || s === 'nonpayment') return 'non-payment';
  if (s === 'disabled' || s === 'inactive') return 'disabled';
  // Live session wins for otherwise-active accounts
  if (c.online) return 'online';
  return 'offline';
}

const CLIENT_COLORS: Record<ClientState, { fill: string; glow: string }> = {
  online: { fill: '#22c55e', glow: 'rgba(34,197,94,0.55)' },
  offline: { fill: '#ef4444', glow: 'rgba(239,68,68,0.5)' },
  expired: { fill: '#f43f5e', glow: 'rgba(244,63,94,0.45)' },
  'non-payment': { fill: '#f59e0b', glow: 'rgba(245,158,11,0.5)' },
  disabled: { fill: '#94a3b8', glow: 'rgba(148,163,184,0.4)' },
};

/** CSS class for animated client cables (dashes run NAP → ONU via JS dashOffset). */
function clientCableClass(state: ClientState, highlighted: boolean): string {
  const base = `flow-line-client flow-line-client-${state}`;
  return highlighted ? `${base} is-hot` : base;
}

type FlowDashEntry = {
  getEl: () => SVGPathElement | null;
  offsetRef: { current: number };
  optsRef: { current: { dashArray: string; speed: number; className: string } };
};

/** One shared rAF for all animated cables (avoids one loop per fiber line). */
const flowDashEntries = new Set<FlowDashEntry>();
let flowDashRaf = 0;
let flowDashLast = 0;

function applyFlowDash(el: SVGPathElement, value: number, dash: string, cls: string) {
  el.setAttribute('stroke-dasharray', dash);
  el.setAttribute('stroke-dashoffset', String(value));
  el.style.setProperty('stroke-dasharray', dash, 'important');
  el.style.setProperty('stroke-dashoffset', String(value), 'important');
  el.style.setProperty('stroke-opacity', '1', 'important');
  for (const c of cls.split(/\s+/)) {
    if (c) el.classList.add(c);
  }
}

function ensureFlowDashLoop() {
  if (flowDashRaf) return;
  flowDashLast = performance.now();
  const tick = (now: number) => {
    if (flowDashEntries.size === 0) {
      flowDashRaf = 0;
      return;
    }
    const dtMs = Math.min(32, Math.max(0, now - flowDashLast));
    flowDashLast = now;
    if (document.visibilityState === 'visible' && dtMs > 0) {
      for (const entry of flowDashEntries) {
        const { dashArray: dash, speed: pxPerSec, className: cls } = entry.optsRef.current;
        entry.offsetRef.current -= (pxPerSec * dtMs) / 1000;
        const el = entry.getEl();
        if (el) applyFlowDash(el, entry.offsetRef.current, dash, cls);
      }
    }
    flowDashRaf = requestAnimationFrame(tick);
  };
  flowDashRaf = requestAnimationFrame(tick);
}

function registerFlowDash(entry: FlowDashEntry) {
  flowDashEntries.add(entry);
  ensureFlowDashLoop();
  return () => {
    flowDashEntries.delete(entry);
  };
}

/**
 * Imperative animated cable — continuous dash flow OLT → NAP → ONU.
 * Offset decreases forever (no wrap reset) so motion never hitch/pauses.
 * Style updates do not remount the layer (avoids animation restarts on poll).
 */
function FlowPolyline({
  positions,
  color,
  weight,
  opacity = 0.95,
  className = '',
  dashArray = '12 16',
  /** Dash travel speed in CSS px per second (along the path toward the child). */
  speed = 48,
}: {
  positions: [number, number][];
  color: string;
  weight: number;
  opacity?: number;
  className?: string;
  dashArray?: string;
  speed?: number;
}) {
  const map = useMap();
  const posKey = JSON.stringify(positions);
  const layerRef = useRef<L.Polyline | null>(null);
  const underlayRef = useRef<L.Polyline | null>(null);
  const offsetRef = useRef(0);
  const optsRef = useRef({ color, weight, opacity, className, dashArray, speed });
  optsRef.current = { color, weight, opacity, className, dashArray, speed };

  useEffect(() => {
    if (!map || !positions?.length) return;

    const { color: c0, weight: w0, opacity: o0, className: cls0, dashArray: dash0 } = optsRef.current;
    const anyMap = map as L.Map & { __flowSvg?: L.SVG };
    if (!anyMap.__flowSvg) {
      anyMap.__flowSvg = L.svg({ padding: 0.5 });
      anyMap.__flowSvg.addTo(map);
    }
    const renderer = anyMap.__flowSvg;

    const underlay = L.polyline(positions, {
      color: c0,
      weight: Math.max(1.5, w0 - 0.5),
      opacity: Math.min(0.35, o0 * 0.4),
      interactive: false,
      className: 'flow-line-underlay',
      lineCap: 'round',
      lineJoin: 'round',
      renderer,
    }).addTo(map);

    const layer = L.polyline(positions, {
      color: c0,
      weight: w0,
      opacity: o0,
      dashArray: dash0,
      className: cls0,
      lineCap: 'round',
      lineJoin: 'round',
      renderer,
    }).addTo(map);

    underlayRef.current = underlay;
    layerRef.current = layer;

    const getEl = (): SVGPathElement | null => {
      const el =
        (typeof (layer as any).getElement === 'function' ? (layer as any).getElement() : null) ||
        (layer as any)._path ||
        null;
      return el as SVGPathElement | null;
    };

    const el0 = getEl();
    if (el0) applyFlowDash(el0, offsetRef.current, dash0, cls0);

    const unregister = registerFlowDash({ getEl, offsetRef, optsRef });

    return () => {
      unregister();
      map.removeLayer(layer);
      map.removeLayer(underlay);
      layerRef.current = null;
      underlayRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, posKey]);

  // Update paint without remounting (keeps dash motion continuous across polls).
  useEffect(() => {
    const layer = layerRef.current;
    const underlay = underlayRef.current;
    if (!layer) return;
    layer.setStyle({
      color,
      weight,
      opacity,
      dashArray,
      className,
      lineCap: 'round',
      lineJoin: 'round',
    } as L.PathOptions);
    underlay?.setStyle({
      color,
      weight: Math.max(1.5, weight - 0.5),
      opacity: Math.min(0.35, opacity * 0.4),
    });
    // setStyle can wipe dashoffset — restore immediately so motion doesn't hitch.
    const el =
      (typeof (layer as any).getElement === 'function' ? (layer as any).getElement() : null) ||
      (layer as any)._path ||
      null;
    if (el) applyFlowDash(el as SVGPathElement, offsetRef.current, dashArray, className);
  }, [color, weight, opacity, dashArray, className]);

  return null;
}

function findConnector(connectors: Connector[], kind: string, fromId: number, toId: number) {
  return connectors.find((c) => c.kind === kind && c.fromId === fromId && c.toId === toId);
}

function defaultPath(a: [number, number], b: [number, number]): [number, number][] {
  return [a, b];
}

function latLngDist2(a: [number, number], b: [number, number]) {
  const dy = a[0] - b[0];
  const dx = a[1] - b[1];
  return dy * dy + dx * dx;
}

function resolvePath(
  connectors: Connector[],
  kind: string,
  fromId: number,
  toId: number,
  fallback: [number, number][]
): [number, number][] {
  const c = findConnector(connectors, kind, fromId, toId);
  if (c && c.points && c.points.length >= 2) {
    const pts = c.points;
    // Normalize so path always runs from → to (parent → child) for downstream dash animation.
    if (fallback.length >= 2) {
      const from = fallback[0];
      const to = fallback[fallback.length - 1];
      const start = pts[0];
      if (latLngDist2(start, to) < latLngDist2(start, from)) return [...pts].reverse();
    }
    return pts;
  }
  return fallback;
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Server — teal square rack badge + label */
function serverIcon(name: string, active = false) {
  return L.divIcon({
    className: 'map-equip-marker',
    html: `<div class="map-equip-row ${active ? 'is-active' : ''}">
      <span class="map-badge map-badge-server">S</span>
      <span class="map-equip-label">${escapeHtml(name)}</span>
    </div>`,
    iconSize: [110, 28],
    iconAnchor: [14, 14],
  });
}

/** OLT — violet square badge */
function oltIcon(name: string, active = false, online?: boolean | null) {
  const statusDot =
    online == null
      ? ''
      : `<span class="map-status-dot ${online ? 'is-online' : 'is-offline'}"></span>`;
  return L.divIcon({
    className: 'map-equip-marker',
    html: `<div class="map-equip-row ${active ? 'is-active' : ''}">
      <span class="map-badge map-badge-olt">OLT${statusDot}</span>
      <span class="map-equip-label">${escapeHtml(name)}</span>
    </div>`,
    iconSize: [120, 28],
    iconAnchor: [14, 14],
  });
}

/** NAP — fiber distribution / junction box icon */
function napIcon(name: string, active = false) {
  const svg = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
    <rect x="4" y="5" width="16" height="14" rx="2.5" fill="none" stroke="#fff" stroke-width="1.8"/>
    <circle cx="9" cy="12" r="1.5" fill="#fff"/>
    <circle cx="15" cy="12" r="1.5" fill="#fff"/>
    <path d="M9 13.5v4M15 13.5v4M4 9h16" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`;
  return L.divIcon({
    className: 'map-equip-marker',
    html: `<div class="map-equip-row ${active ? 'is-active' : ''}">
      <span class="map-badge map-badge-nap" title="NAP">${svg}</span>
      <span class="map-equip-label">${escapeHtml(name)}</span>
    </div>`,
    iconSize: [110, 28],
    iconAnchor: [14, 14],
  });
}

/** Client ONU — CPE router glyph; pulse when online */
function onuIcon(state: ClientState, hovered = false, selected = false) {
  const { fill, glow } = CLIENT_COLORS[state];
  const size = selected || hovered ? 24 : 20;
  const icon = `<svg viewBox="0 0 20 20" width="12" height="12" aria-hidden="true">
    <rect x="2.5" y="8" width="15" height="8" rx="1.8" fill="#fff"/>
    <circle cx="6" cy="12" r="1.1" fill="${fill}"/>
    <circle cx="10" cy="12" r="1.1" fill="${fill}"/>
    <circle cx="14" cy="12" r="1.1" fill="${fill}"/>
    <path d="M6.5 8 V5.2 a3.5 3.5 0 0 1 7 0 V8" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M8.2 8 V6.2 a1.8 1.8 0 0 1 3.6 0 V8" fill="none" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/>
  </svg>`;
  const cls = [
    'map-onu-round',
    state,
    hovered || selected ? 'is-hot' : '',
    selected ? 'is-selected' : '',
  ].filter(Boolean).join(' ');
  return L.divIcon({
    className: 'map-onu-marker',
    html: `<span class="${cls}" style="--onu-color:${fill};--onu-glow:${glow};width:${size}px;height:${size}px" title="Client / Router">${icon}</span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function equipIcon(name: string, kind: string, active = false, online?: boolean | null) {
  if (kind === 'olt') return oltIcon(name, active, online);
  return napIcon(name, active);
}

/**
 * Full-map weather simulation — a plain screen-space overlay, not tied to
 * map coordinates/zoom, so (unlike a tiled radar image) it never goes blank
 * or misaligned as the map is panned/zoomed.
 */
function MapWeatherOverlay({ category }: { category: WeatherCategory }) {
  const rand = (min: number, max: number) => min + Math.random() * (max - min);
  const drops = useMemo(
    () => Array.from({ length: 70 }, () => ({ left: rand(0, 100), delay: rand(0, 1.5), duration: rand(0.7, 1.3) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [category]
  );
  const flakes = useMemo(
    () => Array.from({ length: 45 }, () => ({ left: rand(0, 100), delay: rand(0, 4), duration: rand(3.5, 6), size: rand(5, 9) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [category]
  );

  if (category === 'rain' || category === 'storm') {
    return (
      <div className="map-weatherfx-layer" aria-hidden>
        {drops.map((p, i) => (
          <span key={i} className="mapfx-drop" style={{ left: `${p.left}%`, animationDelay: `${p.delay}s`, animationDuration: `${p.duration}s` }} />
        ))}
        {category === 'storm' && <span className="mapfx-flash" />}
      </div>
    );
  }
  if (category === 'snow') {
    return (
      <div className="map-weatherfx-layer" aria-hidden>
        {flakes.map((p, i) => (
          <span
            key={i}
            className="mapfx-flake"
            style={{ left: `${p.left}%`, width: p.size, height: p.size, animationDelay: `${p.delay}s`, animationDuration: `${p.duration}s` }}
          />
        ))}
      </div>
    );
  }
  if (category === 'clear') {
    return (
      <div className="map-weatherfx-layer" aria-hidden>
        <span className="mapfx-sunburst" />
      </div>
    );
  }
  if (category === 'cloud') {
    const puffs = (
      <>
        <i className="mapfx-puff mapfx-puff-body" />
        <i className="mapfx-puff mapfx-puff-1" />
        <i className="mapfx-puff mapfx-puff-2" />
        <i className="mapfx-puff mapfx-puff-3" />
        <i className="mapfx-puff mapfx-puff-4" />
        <i className="mapfx-puff mapfx-puff-5" />
      </>
    );
    return (
      <div className="map-weatherfx-layer" aria-hidden>
        <span className="mapfx-cloud mapfx-cloud-1">{puffs}</span>
        <span className="mapfx-cloud mapfx-cloud-2">{puffs}</span>
        <span className="mapfx-cloud mapfx-cloud-3">{puffs}</span>
      </div>
    );
  }
  if (category === 'fog') {
    return (
      <div className="map-weatherfx-layer" aria-hidden>
        <span className="mapfx-fogband mapfx-fogband-1" />
        <span className="mapfx-fogband mapfx-fogband-2" />
        <span className="mapfx-fogband mapfx-fogband-3" />
      </div>
    );
  }
  return null;
}

function FitBounds({ points }: { points: [number, number][] }) {
  const map = useMap();
  const fitted = useRef(false);
  useEffect(() => {
    if (!fitted.current && points.length > 1) {
      map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 18 });
      fitted.current = true;
    }
  }, [map, points]);
  return null;
}

function MapDrawClicks({ active, onAdd }: { active: boolean; onAdd: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      if (active) onAdd(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

function MapPickerClick({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onPick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

function MapInvalidateSize() {
  const map = useMap();
  useEffect(() => {
    const t = setTimeout(() => map.invalidateSize(), 80);
    return () => clearTimeout(t);
  }, [map]);
  return null;
}

type LocDraft = { lat: number; lng: number };

function MapLocationPicker({
  open,
  lat,
  lng,
  fallback,
  onClose,
  onConfirm,
}: {
  open: boolean;
  lat: number;
  lng: number;
  fallback?: { lat: number; lng: number };
  onClose: () => void;
  onConfirm: (lat: number, lng: number) => void;
}) {
  const fb = normalizeMapCenter(fallback?.lat, fallback?.lng);
  const [draft, setDraft] = useState<LocDraft>({ lat: fb.lat, lng: fb.lng });
  // Stable map mount center — do NOT remount when the pin moves (that reset zoom).
  const [mapOrigin, setMapOrigin] = useState<[number, number]>([fb.lat, fb.lng]);
  const [mapSeed, setMapSeed] = useState(0);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open && !wasOpen.current) {
      const next = normalizeMapCenter(Number(lat) || fb.lat, Number(lng) || fb.lng);
      setDraft(next);
      setMapOrigin([next.lat, next.lng]);
      setMapSeed((s) => s + 1);
    }
    wasOpen.current = open;
  }, [open, lat, lng, fb.lat, fb.lng]);

  if (!open) return null;

  return (
    <Modal
      title="Pick on Map"
      subtitle="Click the map to set coordinates, or edit values below."
      onClose={onClose}
      maxWidth="xl"
      footer={
        <ModalFooter
          onCancel={onClose}
          onConfirm={() => onConfirm(draft.lat, draft.lng)}
          confirmLabel="Use Location"
        />
      }
    >
      <div className="space-y-3">
        <div className="h-72 rounded-xl overflow-hidden border border-slate-200 relative">
          <MapContainer
            key={`location-picker-${mapSeed}`}
            center={mapOrigin}
            zoom={17}
            minZoom={3}
            maxZoom={22}
            style={{ height: '100%', width: '100%' }}
            scrollWheelZoom
          >
            <TileLayer
              attribution="&copy; OpenStreetMap"
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              maxZoom={22}
              maxNativeZoom={19}
            />
            <MapInvalidateSize />
            <MapPickerClick onPick={(la, ln) => setDraft({ lat: Number(la.toFixed(8)), lng: Number(ln.toFixed(8)) })} />
            <Marker position={[draft.lat, draft.lng]} icon={L.divIcon({
              className: 'map-equip-marker',
              html: '<span class="map-picker-pin"></span>',
              iconSize: [18, 18],
              iconAnchor: [9, 9],
            })} />
          </MapContainer>
          <div className="absolute top-2 left-2 z-[500] bg-white/95 text-[11px] text-slate-600 px-2 py-1 rounded border border-slate-200 shadow-sm">
            Click map to place pin
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Latitude">
            <input
              className="input font-mono text-sm"
              type="number"
              step="any"
              value={draft.lat}
              onChange={(e) => setDraft((d) => ({ ...d, lat: Number(e.target.value) }))}
            />
          </FormField>
          <FormField label="Longitude">
            <input
              className="input font-mono text-sm"
              type="number"
              step="any"
              value={draft.lng}
              onChange={(e) => setDraft((d) => ({ ...d, lng: Number(e.target.value) }))}
            />
          </FormField>
        </div>
      </div>
    </Modal>
  );
}

const emptyNap = (
  kind: 'nap' | 'olt' = 'nap',
  parentId: number | null = null,
  center?: { lat: number; lng: number }
): Partial<Nap> => {
  const c = normalizeMapCenter(center?.lat, center?.lng);
  return {
    name: '',
    code: kind === 'nap' ? '' : '',
    kind,
    lat: c.lat,
    lng: c.lng,
    ports: kind === 'olt' ? 8 : 8,
    parentId,
    status: 'active',
    address: '',
    splitterRatio: kind === 'nap' ? '1:8' : '',
    splitterType: kind === 'nap' ? 'PLC' : null,
    fbtcLeg: kind === 'nap' ? 'through' : null,
    originSplitterId: null,
    txDbm: kind === 'olt' ? 5 : null,
    ponPort: kind === 'nap' ? 1 : null,
  };
};

export default function ClientsMap() {
  const { current } = useRouterDevice();
  const [servers, setServers] = useState<ServerNode[]>([]);
  const [naps, setNaps] = useState<Nap[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [stats, setStats] = useState<any>({});
  const [search, setSearch] = useState('');
  const [topoOpen, setTopoOpen] = useState(false);
  const [editNap, setEditNap] = useState<Partial<Nap> | null>(null);
  /** NAP form: upstream from OLT, from another NAP (parentId), or from a standalone Splitter. */
  const [napUpstream, setNapUpstream] = useState<'olt' | 'nap' | 'splitter'>('olt');
  const [splitters, setSplitters] = useState<Splitter[]>([]);
  const [editSplitter, setEditSplitter] = useState<Partial<Splitter> | null>(null);
  const [editServer, setEditServer] = useState<Partial<ServerNode> | null>(null);
  const [mapPickServer, setMapPickServer] = useState<ServerNode | null>(null);
  const [mapPickClient, setMapPickClient] = useState<Client | null>(null);
  const [pickFor, setPickFor] = useState<'nap' | 'server' | null>(null);
  const [busy, setBusy] = useState(false);
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Client | null>(null);
  const [routeKind, setRouteKind] = useState<RouteKind>('olt-nap');
  const [routeFrom, setRouteFrom] = useState<number | ''>('');
  const [routeTo, setRouteTo] = useState<number | ''>('');
  const [drawMode, setDrawMode] = useState(false);
  const [drawPoints, setDrawPoints] = useState<[number, number][]>([]);
  const [defaultCenter, setDefaultCenter] = useState({ lat: FALLBACK_MAP_LAT, lng: FALLBACK_MAP_LNG });
  const [draftDefault, setDraftDefault] = useState({ lat: String(FALLBACK_MAP_LAT), lng: String(FALLBACK_MAP_LNG) });
  const [defaultBusy, setDefaultBusy] = useState(false);
  const [defaultMsg, setDefaultMsg] = useState('');
  const [splitterRows, setSplitterRows] = useState<SplitterRefLike[]>([]);

  const loadSplitters = () => api.get('/splitters').then((r) => setSplitters(r.data || []));
  useEffect(() => {
    api.get('/tech-tools/splitters').then((r) => setSplitterRows(r.data || []));
    loadSplitters();
  }, []);

  const napChainById = useMemo(() => new Map(naps.map((n) => [n.id, n as ChainNapLike])), [naps]);
  const splittersById = useMemo(() => new Map(splitters.map((s) => [s.id, s as SplitterLike])), [splitters]);

  /** Live dBm-received preview for the NAP modal — overlays the in-progress edit onto the loaded chain. */
  const napPreview = useMemo(() => {
    if (!editNap || editNap.kind !== 'nap' || !editNap.splitterType || !editNap.splitterRatio) return null;
    const previewId = editNap.id ?? -1;
    const merged = new Map(napChainById);
    merged.set(previewId, {
      id: previewId,
      name: editNap.name || 'New NAP',
      kind: 'nap',
      parentId: editNap.parentId ?? null,
      originSplitterId: editNap.originSplitterId ?? null,
      splitterType: editNap.splitterType,
      splitterRatio: editNap.splitterRatio,
      fbtcLeg: editNap.fbtcLeg,
      ports: editNap.ports,
    });
    return computeNapChainDbm(previewId, merged, splitterRows, splittersById);
  }, [editNap, napChainById, splitterRows, splittersById]);

  const load = useCallback(() => {
    const q = current?.id ? `?routerId=${current.id}` : '';
    return api.get(`/map${q}`, { timeout: 15000 }).then((r) => {
      setServers(r.data.servers || []);
      setNaps(r.data.naps);
      setClients(r.data.clients);
      setConnectors(r.data.connectors || []);
      setStats(r.data.stats);
      const dc = normalizeMapCenter(r.data.defaultCenter?.lat, r.data.defaultCenter?.lng);
      setDefaultCenter(dc);
      setDraftDefault({ lat: String(dc.lat), lng: String(dc.lng) });
    });
  }, [current?.id]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    const tick = async () => {
      if (cancelled) return;
      try {
        await load();
      } catch {
        /* ignore — next poll retries */
      }
      if (cancelled) return;
      const { pollHints, refreshApplianceHints } = await import('../lib/appliance');
      void refreshApplianceHints();
      timer = window.setTimeout(tick, pollHints().map);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [load]);

  const olt = useMemo(() => naps.find((n) => n.kind === 'olt'), [naps]);
  const olts = useMemo(() => naps.filter((n) => n.kind === 'olt'), [naps]);
  const napNodes = useMemo(() => naps.filter((n) => n.kind === 'nap'), [naps]);
  const napsById = useMemo(() => Object.fromEntries(naps.map((n) => [n.id, n])), [naps]);

  const [weather, setWeather] = useState<Record<string, WeatherNow | null>>({});
  const weatherTargets = useMemo(
    () => [
      ...servers.map((s) => ({ key: `srv-${s.id}`, lat: s.lat, lng: s.lng })),
      ...olts.map((o) => ({ key: `olt-${o.id}`, lat: o.lat, lng: o.lng })),
    ],
    [servers, olts]
  );

  /**
   * Full-map weather simulation — off by default, opt-in via the toolbar.
   * Unlike a tiled radar image, this is a plain screen-space overlay (not
   * georeferenced), so it has no native zoom level and never breaks or goes
   * blank as the map is zoomed in/out over an OLT.
   */
  const [weatherFxOn, setWeatherFxOn] = useState(false);

  // Fetch weather only when Weather FX is on (drives overlay category).
  useEffect(() => {
    if (!weatherFxOn || weatherTargets.length === 0) return;
    let cancelled = false;
    const run = () => {
      weatherTargets.forEach(({ key, lat, lng }) => {
        fetchCurrentWeather(lat, lng).then((w) => {
          if (!cancelled) setWeather((prev) => ({ ...prev, [key]: w }));
        });
      });
    };
    run();
    const t = setInterval(run, 15 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weatherFxOn, JSON.stringify(weatherTargets)]);

  const dominantWeatherCategory = useMemo<WeatherCategory | null>(() => {
    const counts: Partial<Record<WeatherCategory, number>> = {};
    for (const w of Object.values(weather)) {
      if (!w) continue;
      const cat = weatherCategory(w.code);
      counts[cat] = (counts[cat] || 0) + 1;
    }
    const entries = Object.entries(counts) as [WeatherCategory, number][];
    if (entries.length === 0) return null;
    entries.sort((a, b) => b[1] - a[1]);
    return entries[0][0];
  }, [weather]);

  /** Topology-valid "From" options for the selected cable route type. */
  const routeFromOptions = useMemo(() => {
    if (routeKind === 'server-olt') return servers.map((s) => ({ id: s.id, label: s.name }));
    if (routeKind === 'olt-nap') {
      return olts
        .filter((o) => napNodes.some((n) => Number(n.parentId) === o.id))
        .map((o) => ({ id: o.id, label: o.name }));
    }
    if (routeKind === 'nap-nap') {
      return napNodes
        .filter((n) => napNodes.some((c) => Number(c.parentId) === n.id))
        .map((n) => ({ id: n.id, label: n.name }));
    }
    // nap-client
    return napNodes
      .filter((n) => clients.some((c) => Number(c.napId) === n.id))
      .map((n) => ({ id: n.id, label: n.name }));
  }, [routeKind, servers, olts, napNodes, clients]);

  /** Topology-valid "To" options for the selected From endpoint. */
  const routeToOptions = useMemo(() => {
    if (!routeFrom) return [] as { id: number; label: string }[];
    const fromId = Number(routeFrom);
    if (routeKind === 'server-olt') return olts.map((o) => ({ id: o.id, label: o.name }));
    if (routeKind === 'olt-nap') {
      return napNodes
        .filter((n) => Number(n.parentId) === fromId)
        .map((n) => ({ id: n.id, label: n.name }));
    }
    if (routeKind === 'nap-nap') {
      return napNodes
        .filter((n) => Number(n.parentId) === fromId)
        .map((n) => ({ id: n.id, label: n.name }));
    }
    return clients
      .filter((c) => Number(c.napId) === fromId)
      .map((c) => ({
        id: c.id,
        label: `${c.customer || c.username}${c.username && c.customer ? ` (${c.username})` : ''}`,
      }));
  }, [routeKind, routeFrom, olts, napNodes, clients]);

  /** Clients assigned to the selected NAP (for NAP → Client route "To" list). */
  const clientsUnderSelectedNap = useMemo(() => {
    if (routeKind !== 'nap-client' || !routeFrom) return [];
    const napId = Number(routeFrom);
    return clients.filter((c) => Number(c.napId) === napId);
  }, [routeKind, routeFrom, clients]);

  /** Parent NAP options for Upstream = From NAP (exclude self + anything that would cycle). */
  const parentNapOptions = useMemo(() => {
    const editingId = editNap?.id ? Number(editNap.id) : null;
    return napNodes.filter((n) => {
      if (editingId && n.id === editingId) return false;
      if (!editingId) return true;
      // Reject if editingId appears in n's ancestor chain (n is under editingId).
      let cur: number | null | undefined = n.parentId;
      const seen = new Set<number>();
      while (cur && !seen.has(cur)) {
        if (cur === editingId) return false;
        seen.add(cur);
        cur = napsById[cur]?.parentId;
      }
      return true;
    });
  }, [napNodes, editNap?.id, napsById]);

  const openNewNap = () => {
    setNapUpstream('olt');
    setEditNap(emptyNap('nap', olt?.id || olts[0]?.id || null, defaultCenter));
  };

  const openEditNap = (n: Nap) => {
    if (n.originSplitterId) {
      setNapUpstream('splitter');
    } else {
      const parent = n.parentId ? napsById[n.parentId] : null;
      setNapUpstream(parent?.kind === 'nap' ? 'nap' : 'olt');
    }
    setEditNap({ ...n });
  };

  const saveDefaultCenter = async () => {
    const next = normalizeMapCenter(draftDefault.lat, draftDefault.lng);
    if (Number(draftDefault.lat) < -90 || Number(draftDefault.lat) > 90 || Number(draftDefault.lng) < -180 || Number(draftDefault.lng) > 180) {
      setDefaultMsg('Latitude must be −90…90 and longitude −180…180.');
      return;
    }
    setDefaultBusy(true);
    setDefaultMsg('');
    try {
      const r = await api.put('/map/default-center', next);
      const saved = normalizeMapCenter(r.data?.lat, r.data?.lng);
      setDefaultCenter(saved);
      setDraftDefault({ lat: String(saved.lat), lng: String(saved.lng) });
      setDefaultMsg('Default map coordinates saved.');
    } catch (e: any) {
      setDefaultMsg(e?.response?.data?.error || 'Could not save default coordinates.');
    } finally {
      setDefaultBusy(false);
    }
  };

  const center: [number, number] = olt
    ? [olt.lat, olt.lng]
    : servers[0]
      ? [servers[0].lat, servers[0].lng]
      : [defaultCenter.lat, defaultCenter.lng];
  const highlightId = selected?.id ?? hoveredId;

  const chainFor = useCallback((clientId: number) => {
    const c = clients.find((x) => x.id === clientId);
    if (!c) return null;
    const nap = c.napId ? napsById[c.napId] : null;
    const srv = c.routerId ? servers.find((s) => s.id === c.routerId) : servers[0];
    return { clientId: c.id, napId: nap?.id, oltId: olt?.id, serverId: srv?.id };
  }, [clients, napsById, olt, servers]);

  const highlightChain = highlightId ? chainFor(highlightId) : null;

  const q = search.trim().toLowerCase();
  const filteredClients = clients.filter((c) => {
    if (!q) return true;
    return (
      c.username.toLowerCase().includes(q) ||
      (c.customer || '').toLowerCase().includes(q) ||
      (c.account || '').toLowerCase().includes(q) ||
      (c.address || '').toLowerCase().includes(q)
    );
  });

  const allPoints: [number, number][] = useMemo(
    () => [
      ...servers.map((s) => [s.lat, s.lng] as [number, number]),
      ...naps.map((n) => [n.lat, n.lng] as [number, number]),
      ...clients.map((c) => [c.lat, c.lng] as [number, number]),
    ],
    [servers, naps, clients]
  );

  const lineDim = (partOfHighlight: boolean) => {
    if (!highlightChain) return 1;
    return partOfHighlight ? 1 : 0.12;
  };

  const saveNap = async () => {
    if (!editNap?.name?.trim()) return;
    setBusy(true);
    try {
      if (editNap.id) await api.put(`/naps/${editNap.id}`, editNap);
      else await api.post('/naps', editNap);
      setEditNap(null);
      load();
    } finally {
      setBusy(false);
    }
  };

  const saveServerMap = async (server: ServerNode, lat: number, lng: number) => {
    setBusy(true);
    try {
      await api.put(`/map/servers/${server.id}`, { ...server, lat, lng });
      setMapPickServer(null);
      load();
    } finally {
      setBusy(false);
    }
  };

  const saveClientMap = async (client: Client, lat: number, lng: number) => {
    setBusy(true);
    try {
      await api.put(`/map/clients/${client.id}`, { lat, lng });
      setMapPickClient(null);
      setSelected((sel) => (sel?.id === client.id ? { ...sel, lat, lng } : sel));
      load();
    } finally {
      setBusy(false);
    }
  };

  /** Jump straight into cable-path editing for this client's NAP connection. */
  const editClientRoute = (client: Client) => {
    if (!client.napId) {
      alert('This client has no NAP assigned yet — set its NAP under PPPoE Management first.');
      return;
    }
    const fromId = client.napId;
    const toId = client.id;
    if (!isValidTopologyPair('nap-client', fromId, toId)) {
      alert('Only existing topology links can be edited.');
      return;
    }
    const existing = findConnector(connectors, 'nap-client', fromId, toId);
    setRouteKind('nap-client');
    setRouteFrom(fromId);
    setRouteTo(toId);
    setDrawPoints(existing?.points?.slice(1, -1) || []);
    setDrawMode(true);
    setTopoOpen(true);
    setSelected(null);
  };

  const saveServer = async () => {
    if (!editServer?.id || !editServer.name?.trim()) return;
    setBusy(true);
    try {
      await api.put(`/map/servers/${editServer.id}`, editServer);
      setEditServer(null);
      load();
    } finally {
      setBusy(false);
    }
  };

  const deleteNap = async (id: number) => {
    if (!confirm('Delete this topology node?')) return;
    try {
      await api.delete(`/naps/${id}`);
      load();
    } catch (e: any) {
      alert(e?.response?.data?.error || 'Could not delete');
    }
  };

  const isValidTopologyPair = (kind: RouteKind, fromId: number, toId: number) => {
    if (kind === 'server-olt') return !!servers.find((s) => s.id === fromId) && !!olts.find((o) => o.id === toId);
    if (kind === 'olt-nap') {
      const n = napsById[toId];
      return !!olts.find((o) => o.id === fromId) && !!n && Number(n.parentId) === fromId;
    }
    if (kind === 'nap-nap') {
      const n = napsById[toId];
      const p = napsById[fromId];
      return !!p && p.kind === 'nap' && !!n && n.kind === 'nap' && Number(n.parentId) === fromId;
    }
    return clients.some((c) => c.id === toId && Number(c.napId) === fromId);
  };

  const startDraw = () => {
    if (!routeFrom || !routeTo) {
      alert('Select a topology connection (From / To) first.');
      return;
    }
    const fromId = Number(routeFrom);
    const toId = Number(routeTo);
    if (!isValidTopologyPair(routeKind, fromId, toId)) {
      alert('Only existing topology links can be edited. Set NAP parent / client NAP assignment first.');
      return;
    }
    const existing = findConnector(connectors, routeKind, fromId, toId);
    setDrawPoints(existing?.points?.slice(1, -1) || []);
    setDrawMode(true);
  };

  const undoDrawPoint = () => {
    setDrawPoints((p) => p.slice(0, -1));
  };

  const saveRoute = async () => {
    if (!routeFrom || !routeTo) return;
    const fromId = Number(routeFrom);
    const toId = Number(routeTo);
    if (!isValidTopologyPair(routeKind, fromId, toId)) {
      alert('Only existing topology links can be saved.');
      return;
    }
    const ends = resolveEndpoints(routeKind, fromId, toId, servers, napsById, clients);
    if (!ends) return;
    // One street path per topology connection (server upserts UNIQUE kind+from+to).
    const points: [number, number][] = [ends[0], ...drawPoints, ends[1]];
    await api.post('/map/connectors', { kind: routeKind, fromId, toId, points });
    setDrawMode(false);
    setDrawPoints([]);
    load();
  };

  const deleteRoute = async () => {
    if (!routeFrom || !routeTo) return;
    await api.delete('/map/connectors', { params: { kind: routeKind, fromId: routeFrom, toId: routeTo } });
    setDrawMode(false);
    setDrawPoints([]);
    load();
  };

  const savedRouteCount = connectors.length;
  const pickLat = pickFor === 'server' ? Number(editServer?.lat) || center[0] : Number(editNap?.lat) || center[0];
  const pickLng = pickFor === 'server' ? Number(editServer?.lng) || center[1] : Number(editNap?.lng) || center[1];

  return (
    <Layout title="Topology" fullBleed>
      <div className="map-page-shell">
        <div className="map-toolbar bg-white border-b border-slate-200 px-3 py-2.5 flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-4 flex-wrap text-sm text-slate-500">
            <span>Servers: <b className="text-slate-700">{stats.servers ?? '—'}</b></span>
            <span>OLTs: <b className="text-slate-700">{stats.olts ?? '—'}</b></span>
            <span>NAPs: <b className="text-slate-700">{stats.naps ?? '—'}</b></span>
            <span>
              NAP ports:{' '}
              <b className="text-slate-700">
                {napNodes.reduce((s, n) => s + (n.usedPorts ?? 0), 0)}/
                {napNodes.reduce((s, n) => s + (n.ports || 0), 0)} used
              </b>
              {napNodes.some((n) => (n.availablePorts ?? 1) <= 0) && (
                <span className="text-rose-600 ml-1">
                  · {napNodes.filter((n) => (n.availablePorts ?? 1) <= 0).length} full
                </span>
              )}
            </span>
            <span>
              Clients with location:{' '}
              <b className="text-slate-700">{(stats.totalClients ?? 0) - (stats.withoutLocation || 0)}</b>
              <span className="text-slate-400"> ({stats.withoutLocation ?? 0} not shown)</span>
            </span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              className={`inline-flex items-center gap-2 text-sm border rounded-lg px-3 py-1.5 ${topoOpen ? 'border-brand-300 bg-brand-50 text-brand-700' : 'border-slate-200 hover:bg-slate-50 text-slate-600'}`}
              onClick={() => setTopoOpen((v) => !v)}
            >
              <SlidersHorizontal size={15} /> Topology Config
            </button>
            <button
              type="button"
              title="Simulate the current weather (rain/snow/sun/clouds/fog) across the whole map"
              className={`inline-flex items-center gap-2 text-sm border rounded-lg px-3 py-1.5 ${weatherFxOn ? 'border-brand-300 bg-brand-50 text-brand-700' : 'border-slate-200 hover:bg-slate-50 text-slate-600'}`}
              onClick={() => setWeatherFxOn((v) => !v)}
            >
              <Sparkles size={15} /> Weather FX
            </button>
            <div className="relative">
              <Search size={15} className="absolute left-2.5 top-2.5 text-slate-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, username, account#, address..."
                className="text-sm border border-slate-200 rounded-lg pl-8 pr-3 py-2 w-64 sm:w-80 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <span className="hidden lg:inline text-xs text-slate-400 max-w-md">
              Cables: Online green · Offline red · Expired rose · Non-payment amber · Disabled gray (animated OLT → NAP → ONU)
            </span>
          </div>
        </div>

        {topoOpen && (
          <div className="map-toolbar bg-slate-50/90 border-b border-slate-200 px-3 py-3 max-h-[46vh] overflow-y-auto shrink-0">
            <div className="card p-3 mb-3">
              <div className="flex items-center gap-2 mb-2">
                <MapPin size={15} className="text-brand-500" />
                <h3 className="text-sm font-semibold text-slate-700">Default map coordinates</h3>
                <span className="text-xs text-slate-400 ml-auto">Used by map picker when a device has no location yet</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end">
                <FormField label="Default latitude">
                  <input
                    className="input font-mono text-sm"
                    type="number"
                    step="any"
                    value={draftDefault.lat}
                    onChange={(e) => setDraftDefault((d) => ({ ...d, lat: e.target.value }))}
                  />
                </FormField>
                <FormField label="Default longitude">
                  <input
                    className="input font-mono text-sm"
                    type="number"
                    step="any"
                    value={draftDefault.lng}
                    onChange={(e) => setDraftDefault((d) => ({ ...d, lng: e.target.value }))}
                  />
                </FormField>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="btn-primary text-sm" onClick={saveDefaultCenter} disabled={defaultBusy}>
                    {defaultBusy ? 'Saving…' : 'Save defaults'}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary text-sm"
                    onClick={() =>
                      setDraftDefault({
                        lat: String(FALLBACK_MAP_LAT),
                        lng: String(FALLBACK_MAP_LNG),
                      })
                    }
                  >
                    Reset built-in
                  </button>
                </div>
              </div>
              {defaultMsg && <p className="text-xs text-slate-500 mt-2">{defaultMsg}</p>}
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-4 gap-3 mb-3">
              <TopoPanel
                title="Server Configuration"
                action={<span className="text-[11px] text-slate-400">Map location</span>}
              >
                {servers.length === 0 ? (
                  <p className="text-sm text-slate-400 py-4 text-center">No servers added.</p>
                ) : (
                  servers.map((s) => (
                    <TopoRow
                      key={s.id}
                      name={s.name}
                      sub={`${s.host || '—'} · ${s.status || '—'}`}
                      right={
                        <div className="flex gap-2">
                          <button type="button" className="text-xs text-sky-600" onClick={() => setEditServer({ ...s })}>Edit</button>
                          <button type="button" className="text-xs text-brand-600" onClick={() => setMapPickServer(s)}>Edit map</button>
                        </div>
                      }
                    />
                  ))
                )}
              </TopoPanel>
              <TopoPanel
                title="OLT Configuration"
                action={
                  <button type="button" className="text-xs text-brand-600 hover:underline" onClick={() => setEditNap(emptyNap('olt', null, defaultCenter))}>
                    <Plus size={12} className="inline" /> New OLT
                  </button>
                }
              >
                {olts.length === 0 ? (
                  <p className="text-sm text-slate-400 py-4 text-center">No OLT configured.</p>
                ) : (
                  olts.map((o) => {
                    const live = o.host ? (o.status === 'online' ? 'online' : o.status === 'offline' ? 'offline' : o.status || '—') : (o.status || 'active');
                    return (
                    <TopoRow
                      key={o.id}
                      name={o.name}
                      sub={`${o.host ? `${o.host} · ` : ''}PONs: ${o.ports} · ${live}${o.vendor ? ` · ${o.vendor}` : ''}`}
                      right={
                        <div className="flex gap-2 items-center">
                          {o.host && (
                            <span className={`text-[10px] font-semibold uppercase ${o.status === 'online' ? 'text-emerald-600' : 'text-rose-600'}`}>
                              {o.status === 'online' ? 'Online' : 'Offline'}
                            </span>
                          )}
                          <button type="button" className="text-xs text-sky-600" onClick={() => setEditNap({ ...o })}>Edit</button>
                          <button type="button" className="text-xs text-rose-600" onClick={() => deleteNap(o.id)}>Delete</button>
                        </div>
                      }
                    />
                    );
                  })
                )}
              </TopoPanel>
              <TopoPanel
                title="NAP Configuration"
                action={
                  <button
                    type="button"
                    className="text-xs text-brand-600 hover:underline"
                    onClick={openNewNap}
                  >
                    <Plus size={12} className="inline" /> New NAP
                  </button>
                }
              >
                <div className="max-h-44 overflow-y-auto space-y-1 pr-1">
                  {napNodes.length === 0 ? (
                    <p className="text-sm text-slate-400 py-4 text-center">No NAPs.</p>
                  ) : (
                    napNodes.map((n) => {
                      const parent = n.parentId ? napsById[n.parentId] : null;
                      const originSplitter = n.originSplitterId ? splittersById.get(n.originSplitterId) : null;
                      const fromLabel = originSplitter
                        ? `Splitter ${originSplitter.name}`
                        : parent
                          ? `${parent.kind === 'nap' ? 'NAP' : 'OLT'} ${parent.name}`
                          : null;
                      const used = n.usedPorts ?? 0;
                      const free = n.availablePorts ?? Math.max(0, (n.ports || 0) - used);
                      const full = free <= 0;
                      const nearly = !full && free <= 2;
                      return (
                      <TopoRow
                        key={n.id}
                        name={n.code ? `${n.code}` : n.name}
                        sub={`${n.name}${fromLabel ? ` · From: ${fromLabel}` : ''}${n.ponPort ? ` · PON ${n.ponPort}` : ''} · Ports ${used}/${n.ports}${full ? ' FULL' : nearly ? ' low' : ''}`}
                        right={
                          <div className="flex gap-2 items-center">
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${full ? 'bg-rose-100 text-rose-700' : nearly ? 'bg-amber-100 text-amber-700' : 'bg-emerald-50 text-emerald-700'}`}>
                              {free} free
                            </span>
                            <button type="button" className="text-xs text-sky-600" onClick={() => openEditNap(n)}>Edit</button>
                            <button type="button" className="text-xs text-rose-600" onClick={() => deleteNap(n.id)}>Delete</button>
                          </div>
                        }
                      />
                    );
                    })
                  )}
                </div>
              </TopoPanel>
              <TopoPanel
                title="Splitter Configuration"
                action={
                  <button
                    type="button"
                    className="text-xs text-brand-600 hover:underline"
                    onClick={() => setEditSplitter({ type: 'PLC', ratio: '1:8', originKind: 'olt', originId: olt?.id || olts[0]?.id || null, fbtcLeg: 'through' })}
                  >
                    <Plus size={12} className="inline" /> New Splitter
                  </button>
                }
              >
                <div className="max-h-44 overflow-y-auto space-y-1 pr-1">
                  {splitters.length === 0 ? (
                    <p className="text-sm text-slate-400 py-4 text-center">No splitters.</p>
                  ) : (
                    splitters.map((s) => {
                      const originLabel =
                        s.originKind === 'olt'
                          ? `OLT ${olts.find((o) => o.id === s.originId)?.name || '—'}`
                          : s.originKind === 'nap'
                            ? `NAP ${napsById[s.originId || -1]?.name || '—'}`
                            : `Splitter ${splittersById.get(s.originId || -1)?.name || '—'}`;
                      const inputDbm = resolveSplitterInputDbm(s.id, splittersById, napChainById, splitterRows);
                      const isAsymmetric = isAsymmetricType(s.type);
                      const splitterRef = splitterRows.find(
                        (r) => r.type === s.type && r.ratio === s.ratio && (s.type !== 'FBTC' || Number(r.ports) === Number(s.ports))
                      );
                      const outThrough = inputDbm != null && splitterRef ? inputDbm - splitterRef.throughLossDb : null;
                      const outTap = inputDbm != null && isAsymmetric && splitterRef?.tapLossDb != null ? inputDbm - splitterRef.tapLossDb : null;
                      const outLabel = isAsymmetric
                        ? `Through ${outThrough != null ? outThrough.toFixed(1) : '—'} / Tap ${outTap != null ? outTap.toFixed(1) : '—'} dBm`
                        : `Out ${outThrough != null ? outThrough.toFixed(1) : '—'} dBm`;
                      return (
                        <TopoRow
                          key={s.id}
                          name={`${s.name} — ${s.type} ${s.ratio}`}
                          sub={`From: ${originLabel} · ${outLabel}`}
                          right={
                            <div className="flex gap-2">
                              <button type="button" className="text-xs text-sky-600" onClick={() => setEditSplitter({ ...s })}>Edit</button>
                              <button
                                type="button"
                                className="text-xs text-rose-600"
                                onClick={async () => {
                                  if (!confirm('Delete this splitter?')) return;
                                  try {
                                    await api.delete(`/splitters/${s.id}`);
                                    loadSplitters();
                                  } catch (e: any) {
                                    alert(e?.response?.data?.error || 'Could not delete splitter');
                                  }
                                }}
                              >
                                Delete
                              </button>
                            </div>
                          }
                        />
                      );
                    })
                  )}
                </div>
              </TopoPanel>
            </div>

            <div className="card p-3">
              <div className="flex items-center gap-2 mb-2">
                <Route size={15} className="text-brand-500" />
                <h3 className="text-sm font-semibold text-slate-700">Cable Route (Street Path)</h3>
                <span className="text-xs text-slate-400 ml-auto">Saved routes: {savedRouteCount}</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
                <FormField label="Route type">
                  <select
                    className="input"
                    value={routeKind}
                    onChange={(e) => {
                      setRouteKind(e.target.value as RouteKind);
                      setRouteFrom('');
                      setRouteTo('');
                      setDrawMode(false);
                      setDrawPoints([]);
                    }}
                  >
                    <option value="server-olt">Server → OLT</option>
                    <option value="olt-nap">OLT → NAP</option>
                    <option value="nap-nap">NAP → NAP</option>
                    <option value="nap-client">NAP → Client</option>
                  </select>
                </FormField>
                <FormField label="From" hint="Only topology-linked nodes">
                  <select
                    className="input"
                    value={routeFrom}
                    onChange={(e) => {
                      setRouteFrom(e.target.value ? Number(e.target.value) : '');
                      setRouteTo('');
                      setDrawMode(false);
                      setDrawPoints([]);
                    }}
                  >
                    <option value="">Select…</option>
                    {routeFromOptions.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </FormField>
                <FormField
                  label="To"
                  hint={
                    !routeFrom
                      ? 'Select From first'
                      : routeKind === 'nap-client'
                        ? `${routeToOptions.length} user(s) under this NAP`
                        : `${routeToOptions.length} linked node(s)`
                  }
                >
                  <select
                    className="input"
                    value={routeTo}
                    onChange={(e) => {
                      setRouteTo(e.target.value ? Number(e.target.value) : '');
                      setDrawMode(false);
                      setDrawPoints([]);
                    }}
                    disabled={!routeFrom}
                  >
                    <option value="">{!routeFrom ? 'Select From first…' : 'Select…'}</option>
                    {routeToOptions.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  {routeFrom && routeToOptions.length === 0 && (
                    <p className="text-xs text-amber-700 mt-1">
                      No topology children for this node. Set NAP parent / assign users first.
                    </p>
                  )}
                </FormField>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="btn-primary text-sm" onClick={startDraw} disabled={!routeFrom || !routeTo}>
                    {drawMode ? 'Drawing…' : 'Edit path'}
                  </button>
                  <button type="button" className="btn-secondary text-sm" onClick={saveRoute} disabled={!drawMode}>
                    Save Route
                  </button>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 text-sm px-3 py-2 border border-slate-200 rounded-xl hover:bg-slate-50 disabled:opacity-40"
                    onClick={undoDrawPoint}
                    disabled={!drawMode || drawPoints.length === 0}
                    title="Undo last waypoint"
                  >
                    <Undo2 size={14} /> Undo
                  </button>
                  <button
                    type="button"
                    className="text-sm text-rose-600 px-3 py-2 border border-rose-200 rounded-xl hover:bg-rose-50"
                    onClick={deleteRoute}
                    disabled={!routeFrom || !routeTo}
                  >
                    Delete Saved
                  </button>
                </div>
              </div>
              {drawMode ? (
                <p className="text-xs text-brand-700 mt-2">
                  Editing one street path for this topology link. Click the map to add waypoints · <b>Undo</b> removes the last point · Save when done.
                </p>
              ) : (
                <p className="text-xs text-slate-500 mt-2">
                  One cable path per topology connection. Choose an existing Server/OLT/NAP/Client link, then Edit path.
                </p>
              )}
            </div>
          </div>
        )}

        <div id="map-wrap" className="map-stage overflow-hidden">
          {drawMode && (
            <div className="map-draw-banner bg-brand-600 text-white text-xs font-medium px-4 py-2 rounded-lg shadow-lg flex flex-wrap items-center gap-3">
              <span>
                Editing cable path — click map to add points ({drawPoints.length} waypoint
                {drawPoints.length !== 1 ? 's' : ''})
              </span>
              <button
                type="button"
                className="inline-flex items-center gap-1 underline disabled:opacity-50"
                onClick={undoDrawPoint}
                disabled={drawPoints.length === 0}
              >
                <Undo2 size={12} /> Undo last
              </button>
              <button
                type="button"
                className="underline"
                onClick={() => {
                  setDrawMode(false);
                  setDrawPoints([]);
                }}
              >
                Cancel
              </button>
            </div>
          )}

          {selected && (
            <ClientPanel
              client={selected}
              onClose={() => setSelected(null)}
              onEditLocation={() => setMapPickClient(selected)}
              onEditRoute={() => editClientRoute(selected)}
            />
          )}

          <button
            type="button"
            onClick={() => document.getElementById('map-wrap')?.requestFullscreen?.()}
            className="absolute top-3 right-3 z-[500] bg-white/95 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-600 hover:bg-white flex items-center gap-1.5 shadow-sm"
          >
            <Maximize2 size={13} /> Fullscreen
          </button>

          {weatherFxOn && dominantWeatherCategory && (
            <div className="absolute top-3 left-3 z-[500] bg-slate-900/85 border border-white/20 rounded-lg px-2.5 py-1.5 text-xs text-white flex items-center gap-1.5 shadow-sm">
              <Sparkles size={13} className="text-sky-400" />
              Simulated {dominantWeatherCategory}
            </div>
          )}

          <MapContainer
            center={center}
            zoom={16}
            minZoom={3}
            maxZoom={22}
            style={{ height: '100%', width: '100%' }}
            scrollWheelZoom
            zoomControl
            preferCanvas={false}
          >
            <TileLayer
              attribution="&copy; OpenStreetMap contributors"
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              maxZoom={22}
              maxNativeZoom={19}
            />
            <FitBounds points={allPoints} />
            <MapDrawClicks active={drawMode} onAdd={(lat, lng) => setDrawPoints((p) => [...p, [lat, lng]])} />

            {servers.map((srv) => {
              if (!olt) return null;
              const hi = highlightChain?.serverId === srv.id && highlightChain?.oltId === olt.id;
              const path = resolvePath(connectors, 'server-olt', srv.id, olt.id, defaultPath([srv.lat, srv.lng], [olt.lat, olt.lng]));
              return (
                <FlowPolyline
                  key={`s-olt-${srv.id}`}
                  positions={path}
                  color="#0d9488"
                  weight={hi ? 4 : 3}
                  opacity={0.95 * lineDim(hi)}
                  className="flow-line-backbone"
                  dashArray="12 16"
                  speed={52}
                />
              );
            })}

            {napNodes.map((n) => {
              const parent = n.parentId ? napsById[n.parentId] : null;
              if (!parent) return null;
              const hi =
                (highlightChain?.oltId === parent.id || highlightChain?.napId === parent.id) &&
                highlightChain?.napId === n.id;
              const connKind = parent.kind === 'olt' ? 'olt-nap' : 'nap-nap';
              const path = resolvePath(
                connectors,
                connKind,
                parent.id,
                n.id,
                defaultPath([parent.lat, parent.lng], [n.lat, n.lng])
              );
              return (
                <FlowPolyline
                  key={`parent-nap-${n.id}`}
                  positions={path}
                  color={parent.kind === 'olt' ? '#2563eb' : '#7c3aed'}
                  weight={hi ? 3.5 : 2.75}
                  opacity={0.95 * lineDim(!!hi)}
                  className="flow-line-backbone"
                  dashArray="12 16"
                  speed={56}
                />
              );
            })}

            {filteredClients.map((c) => {
              const nap = c.napId ? napsById[c.napId] : null;
              if (!nap) return null;
              const state = clientState(c);
              const hi = highlightChain?.clientId === c.id;
              const lineColor = CLIENT_COLORS[state].fill;
              // Path parent → child so CSS dash animation runs OLT/NAP → ONU (downstream)
              const path = resolvePath(connectors, 'nap-client', nap.id, c.id, defaultPath([nap.lat, nap.lng], [c.lat, c.lng]));
              return (
                <FlowPolyline
                  key={`cl-${c.id}`}
                  positions={path}
                  color={lineColor}
                  weight={hi ? 3.5 : state === 'online' ? 3 : 2.5}
                  opacity={(state === 'online' ? 0.98 : 0.85) * lineDim(hi)}
                  className={clientCableClass(state, hi)}
                  dashArray={state === 'disabled' ? '6 16' : '12 16'}
                  speed={state === 'online' ? 64 : state === 'disabled' ? 28 : 48}
                />
              );
            })}

            {drawMode && routeFrom && routeTo && (() => {
              const ends = resolveEndpoints(routeKind, Number(routeFrom), Number(routeTo), servers, napsById, clients);
              if (!ends) return null;
              return (
                <Polyline positions={[ends[0], ...drawPoints, ends[1]]} pathOptions={{ color: '#f59e0b', weight: 3, dashArray: '6 4' }} />
              );
            })()}

            {servers.map((s) => {
              return (
                <Marker key={`srv-${s.id}`} position={[s.lat, s.lng]} icon={serverIcon(s.name, highlightChain?.serverId === s.id)}>
                  <Popup>
                    <b>{s.name}</b><br />Server
                  </Popup>
                </Marker>
              );
            })}

            {naps.map((n) => {
              const chain = n.kind === 'nap' ? computeNapChainDbm(n.id, napChainById, splitterRows, splittersById) : null;
              return (
                <Marker
                  key={n.id}
                  position={[n.lat, n.lng]}
                  icon={equipIcon(
                    n.code || n.name,
                    n.kind,
                    highlightChain?.oltId === n.id || highlightChain?.napId === n.id,
                    n.kind === 'olt' && n.host ? n.status === 'online' : null
                  )}
                >
                  <Popup>
                    <b>{n.name}</b><br />
                    {n.kind === 'olt' ? 'OLT' : 'NAP'}
                    {n.host ? <><br />IP: {n.host}</> : null}
                    {n.kind === 'olt' && n.host ? (
                      <><br />Status: <b style={{ color: n.status === 'online' ? '#16a34a' : '#dc2626' }}>{n.status === 'online' ? 'Online' : 'Offline'}</b></>
                    ) : null}
                    {n.kind === 'olt' && n.txDbm != null ? <><br />PON Tx: {n.txDbm} dBm</> : null}
                    {n.kind === 'nap' && n.splitterType && n.splitterRatio ? (
                      <><br />Splitter: {n.splitterType} {n.splitterRatio}</>
                    ) : null}
                    {n.kind === 'nap' && n.originSplitterId ? (
                      <><br />Origin: splitter {splittersById.get(n.originSplitterId)?.name || `#${n.originSplitterId}`}</>
                    ) : null}
                    {n.kind === 'nap' &&
                    ((n.parentId && isAsymmetricType(napsById[n.parentId]?.splitterType)) ||
                      (n.originSplitterId && isAsymmetricType(splittersById.get(n.originSplitterId)?.type))) ? (
                      <>
                        <br />Upstream port:{' '}
                        {ratioLegLabel(
                          n.originSplitterId ? splittersById.get(n.originSplitterId)?.ratio : n.parentId ? napsById[n.parentId]?.splitterRatio : null,
                          n.fbtcLeg === 'tap' ? 'tap' : 'through'
                        )}
                      </>
                    ) : null}
                    {n.kind === 'nap' && chain ? <><br />Est. received: {chain.receivedDbm.toFixed(2)} dBm</> : null}
                    {n.ports != null ? (
                      <>
                        <br />Ports: {n.availablePorts ?? Math.max(0, n.ports - (n.usedPorts ?? 0))} free / {n.ports}
                      </>
                    ) : null}
                    {n.vendor || n.model ? <><br />{[n.vendor, n.model].filter(Boolean).join(' · ')}</> : null}
                  </Popup>
                </Marker>
              );
            })}

            {filteredClients.map((c) => {
              const state = clientState(c);
              const isHover = hoveredId === c.id;
              const isSel = selected?.id === c.id;
              return (
                <Marker
                  key={c.id}
                  position={[c.lat, c.lng]}
                  icon={onuIcon(state, isHover, isSel)}
                  eventHandlers={{
                    mouseover: () => setHoveredId(c.id),
                    mouseout: () => setHoveredId((id) => (id === c.id ? null : id)),
                    click: () => setSelected(c),
                  }}
                >
                  <LTooltip sticky direction="top">
                    <div className="text-[12px] leading-snug min-w-[140px]">
                      <div className="font-semibold">{c.customer}</div>
                      <div className="text-slate-500">{c.username}</div>
                      <div><b style={{ color: CLIENT_COLORS[state].fill }}>{state}</b> · {c.plan}</div>
                    </div>
                  </LTooltip>
                </Marker>
              );
            })}
          </MapContainer>

          {weatherFxOn && dominantWeatherCategory && <MapWeatherOverlay category={dominantWeatherCategory} />}
        </div>
      </div>

      {editServer && (
        <Modal
          title={editServer.id ? 'Edit Server' : 'New Server'}
          onClose={() => setEditServer(null)}
          footer={<ModalFooter onCancel={() => setEditServer(null)} onConfirm={saveServer} confirmLabel="Save Server" busy={busy} />}
        >
          <div className="space-y-3">
            <FormField label="Name" required>
              <input className="input" value={editServer.name || ''} onChange={(e) => setEditServer({ ...editServer, name: e.target.value })} />
            </FormField>
            <div className="grid grid-cols-2 gap-3 items-end">
              <FormField label="Status">
                <select className="input" value={editServer.status || 'online'} onChange={(e) => setEditServer({ ...editServer, status: e.target.value })}>
                  <option value="online">active</option>
                  <option value="offline">offline</option>
                </select>
              </FormField>
              <button type="button" className="btn-secondary text-sm inline-flex items-center justify-center gap-1.5 h-[42px]" onClick={() => setPickFor('server')}>
                <MapPin size={14} /> Pick on Map
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Latitude">
                <input className="input font-mono text-sm" type="number" step="any" value={editServer.lat ?? ''} onChange={(e) => setEditServer({ ...editServer, lat: Number(e.target.value) })} />
              </FormField>
              <FormField label="Longitude">
                <input className="input font-mono text-sm" type="number" step="any" value={editServer.lng ?? ''} onChange={(e) => setEditServer({ ...editServer, lng: Number(e.target.value) })} />
              </FormField>
            </div>
            <FormField label="Address">
              <textarea className="input min-h-[72px]" value={editServer.address || ''} onChange={(e) => setEditServer({ ...editServer, address: e.target.value })} />
            </FormField>
          </div>
        </Modal>
      )}

      {editSplitter && (
        <SplitterModal
          splitter={editSplitter}
          splitters={splitters}
          splitterRows={splitterRows}
          napChainById={napChainById}
          olts={olts}
          napNodes={napNodes}
          onClose={() => setEditSplitter(null)}
          onSaved={() => {
            setEditSplitter(null);
            loadSplitters();
          }}
        />
      )}

      {editNap && (
        <Modal
          title={editNap.id ? `Edit ${editNap.kind === 'olt' ? 'OLT' : 'NAP'}` : `New ${editNap.kind === 'olt' ? 'OLT' : 'NAP'}`}
          onClose={() => setEditNap(null)}
          footer={
            <ModalFooter
              onCancel={() => setEditNap(null)}
              onConfirm={saveNap}
              confirmLabel={editNap.kind === 'olt' ? 'Save OLT' : 'Save NAP'}
              busy={busy}
            />
          }
        >
          <div className="space-y-3">
            {editNap.kind === 'nap' ? (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <FormField label="NAP Code">
                    <input className="input" value={editNap.code || ''} onChange={(e) => setEditNap({ ...editNap, code: e.target.value })} placeholder="NAP1" />
                  </FormField>
                  <FormField label="Name" required>
                    <input className="input" value={editNap.name || ''} onChange={(e) => setEditNap({ ...editNap, name: e.target.value })} />
                  </FormField>
                </div>
                <div className="grid grid-cols-2 gap-3 items-end">
                  <FormField label="Upstream">
                    <select
                      className="input"
                      value={napUpstream}
                      onChange={(e) => {
                        const v = e.target.value === 'nap' ? 'nap' : e.target.value === 'splitter' ? 'splitter' : 'olt';
                        setNapUpstream(v);
                        if (v === 'splitter') {
                          setEditNap({ ...editNap, parentId: null, originSplitterId: splitters[0]?.id || null });
                        } else {
                          const defaultParent = v === 'olt' ? olt?.id || olts[0]?.id || null : parentNapOptions[0]?.id || null;
                          setEditNap({ ...editNap, parentId: defaultParent, originSplitterId: null });
                        }
                      }}
                    >
                      <option value="olt">From OLT</option>
                      <option value="nap">From NAP</option>
                      <option value="splitter">From Splitter</option>
                    </select>
                  </FormField>
                  <button type="button" className="btn-secondary text-sm inline-flex items-center justify-center gap-1.5 h-[42px]" onClick={() => setPickFor('nap')}>
                    <MapPin size={14} /> Pick on Map
                  </button>
                </div>
                {napUpstream === 'olt' ? (
                  <FormField label="OLT" required hint="Parent OLT for this NAP.">
                    <select
                      className="input"
                      value={editNap.parentId || ''}
                      onChange={(e) => setEditNap({ ...editNap, parentId: e.target.value ? Number(e.target.value) : null })}
                    >
                      <option value="">— Select OLT —</option>
                      {olts.map((o) => (
                        <option key={o.id} value={o.id}>{o.name}</option>
                      ))}
                    </select>
                    {olts.length === 0 && (
                      <p className="text-xs text-amber-700 mt-1">No OLT configured yet — add one under OLT Configuration.</p>
                    )}
                  </FormField>
                ) : napUpstream === 'nap' ? (
                  <FormField label="Parent NAP" required hint="Upstream NAP this box feeds from.">
                    <select
                      className="input"
                      value={editNap.parentId || ''}
                      onChange={(e) => setEditNap({ ...editNap, parentId: e.target.value ? Number(e.target.value) : null })}
                    >
                      <option value="">— Select NAP —</option>
                      {parentNapOptions.map((n) => (
                        <option key={n.id} value={n.id}>
                          {n.code ? `${n.code} · ${n.name}` : n.name}
                        </option>
                      ))}
                    </select>
                    {parentNapOptions.length === 0 && (
                      <p className="text-xs text-amber-700 mt-1">No other NAPs available — add a NAP from an OLT first.</p>
                    )}
                  </FormField>
                ) : (
                  <FormField label="Splitter" required hint="Standalone splitter this box feeds from — manage the list under Splitter Configuration.">
                    <select
                      className="input"
                      value={editNap.originSplitterId || ''}
                      onChange={(e) => setEditNap({ ...editNap, originSplitterId: e.target.value ? Number(e.target.value) : null })}
                    >
                      <option value="">— Select Splitter —</option>
                      {splitters.map((s) => (
                        <option key={s.id} value={s.id}>{s.name} ({s.type} {s.ratio})</option>
                      ))}
                    </select>
                    {splitters.length === 0 && (
                      <p className="text-xs text-amber-700 mt-1">No splitters configured yet — add one under Splitter Configuration.</p>
                    )}
                  </FormField>
                )}
                {((napUpstream === 'nap' && editNap.parentId && isAsymmetricType(napsById[editNap.parentId]?.splitterType)) ||
                  (napUpstream === 'splitter' && editNap.originSplitterId && isAsymmetricType(splittersById.get(editNap.originSplitterId)?.type))) && (() => {
                  const originRatio =
                    napUpstream === 'splitter'
                      ? (editNap.originSplitterId && splittersById.get(editNap.originSplitterId)?.ratio) || null
                      : napsById[editNap.parentId!]?.splitterRatio || null;
                  const originName =
                    napUpstream === 'splitter'
                      ? (editNap.originSplitterId && splittersById.get(editNap.originSplitterId)?.name) || 'the splitter'
                      : napsById[editNap.parentId!]?.name || 'the parent NAP';
                  return (
                    <FormField label="Upstream Connection" hint={`Which port of ${originName} (ratio ${originRatio || '—'}) this box is plugged into.`}>
                      <select
                        className="input"
                        value={editNap.fbtcLeg || 'through'}
                        onChange={(e) => setEditNap({ ...editNap, fbtcLeg: e.target.value === 'tap' ? 'tap' : 'through' })}
                      >
                        <option value="through">{ratioLegLabel(originRatio, 'through')} — typical for cascading another box</option>
                        <option value="tap">{ratioLegLabel(originRatio, 'tap')} — this box is plugged into a client port instead</option>
                      </select>
                    </FormField>
                  );
                })()}
                <div className="grid grid-cols-2 gap-3">
                  <FormField label="PON Port">
                    <input className="input" type="number" value={editNap.ponPort ?? ''} onChange={(e) => setEditNap({ ...editNap, ponPort: e.target.value === '' ? null : Number(e.target.value) })} />
                  </FormField>
                  <FormField label="Splitter Ports (capacity)" hint={editNap.splitterType === 'FBTC' ? 'FBTC cassette tray size.' : 'Subscriber ports available on this box.'}>
                    {editNap.splitterType === 'FBTC' ? (
                      <select
                        className="input"
                        value={FBTC_PORT_OPTIONS.includes(Number(editNap.ports)) ? editNap.ports : 8}
                        onChange={(e) => setEditNap({ ...editNap, ports: Number(e.target.value) })}
                      >
                        {FBTC_PORT_OPTIONS.map((p) => (
                          <option key={p} value={p}>{p} ports</option>
                        ))}
                      </select>
                    ) : (
                      <input className="input" type="number" value={editNap.ports ?? 8} onChange={(e) => setEditNap({ ...editNap, ports: Number(e.target.value) })} />
                    )}
                  </FormField>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <FormField label="Splitter Type">
                    <select
                      className="input"
                      value={editNap.splitterType || 'PLC'}
                      onChange={(e) => {
                        const t = e.target.value as 'FBT' | 'PLC' | 'FBTC';
                        const opts = splitterRatioOptions(splitterRows, t);
                        const ratio = opts.includes(editNap.splitterRatio || '') ? editNap.splitterRatio : opts[0] || '';
                        const ports = t === 'FBTC' && !FBTC_PORT_OPTIONS.includes(Number(editNap.ports)) ? 8 : editNap.ports;
                        setEditNap({ ...editNap, splitterType: t, splitterRatio: ratio, ports });
                      }}
                    >
                      <option value="PLC">PLC</option>
                      <option value="FBT">FBT</option>
                      <option value="FBTC">FBTC (tap cassette)</option>
                    </select>
                  </FormField>
                  <FormField label="Splitter Ratio" hint={isAsymmetricType(editNap.splitterType) ? 'through:tap' : undefined}>
                    <select
                      className="input"
                      value={editNap.splitterRatio || ''}
                      onChange={(e) => setEditNap({ ...editNap, splitterRatio: e.target.value })}
                    >
                      {splitterRatioOptions(splitterRows, (editNap.splitterType as 'FBT' | 'PLC' | 'FBTC') || 'PLC').map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                  </FormField>
                </div>
                {editNap.splitterType && (() => {
                  const isAsymmetric = isAsymmetricType(editNap.splitterType);
                  const isFbtcPorts = editNap.splitterType === 'FBTC';
                  const ref = splitterRows.find(
                    (r) =>
                      r.type === editNap.splitterType &&
                      r.ratio === editNap.splitterRatio &&
                      (!isFbtcPorts || Number(r.ports) === Number(editNap.ports))
                  );
                  // Power arriving at this NAP's own splitter input — i.e. the
                  // origin/parent chain's output before this box's own split is applied.
                  const primaryStages = napPreview?.stages ?? [];
                  const incomingDbm = napPreview
                    ? primaryStages.length >= 2
                      ? primaryStages[primaryStages.length - 2].after
                      : napPreview.originDbm
                    : null;
                  const throughDbm = ref && incomingDbm != null ? incomingDbm - ref.throughLossDb : null;
                  const tapDbm = ref?.tapLossDb != null && incomingDbm != null ? incomingDbm - ref.tapLossDb : null;
                  return (
                    <div className="-mt-1 space-y-1.5">
                      <div className="flex items-center gap-4 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
                        {isAsymmetric ? (
                          <>
                            <span className="text-slate-500">
                              Through (trunk continue): <span className="font-semibold text-slate-800">{throughDbm != null ? `${throughDbm.toFixed(2)} dBm` : '—'}</span>
                            </span>
                            <span className="text-slate-500">
                              Tap (subscriber drop): <span className="font-semibold text-slate-800">{tapDbm != null ? `${tapDbm.toFixed(2)} dBm` : '—'}</span>
                            </span>
                          </>
                        ) : (
                          <span className="text-slate-500">
                            Output: <span className="font-semibold text-slate-800">{throughDbm != null ? `${throughDbm.toFixed(2)} dBm` : '—'}</span>
                          </span>
                        )}
                      </div>
                      {isAsymmetric && (
                        <p className="text-xs text-slate-400">
                          This box's own clients draw from its tap leg; a NAP cascaded off its through leg
                          continues the trunk. If a downstream NAP is instead wired into a tap leg, set that on
                          the downstream NAP's own "Upstream Connection" field.
                        </p>
                      )}
                    </div>
                  );
                })()}
                {napPreview && (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 flex items-center justify-between">
                    <span>
                      Est. received power {napPreview.oltName ? `from ${napPreview.oltName}` : ''}
                      {napPreview.stages.some((s) => s.lossDb == null) && (
                        <span className="text-amber-600"> — some hops missing a reference match</span>
                      )}
                    </span>
                    <span className="font-semibold text-slate-800">{napPreview.receivedDbm.toFixed(2)} dBm</span>
                  </div>
                )}
                <FormField label="Status">
                  <select className="input" value={editNap.status || 'active'} onChange={(e) => setEditNap({ ...editNap, status: e.target.value })}>
                    <option value="active">active</option>
                    <option value="inactive">inactive</option>
                  </select>
                </FormField>
              </>
            ) : (
              <>
                <FormField label="Name" required>
                  <input className="input" value={editNap.name || ''} onChange={(e) => setEditNap({ ...editNap, name: e.target.value })} />
                </FormField>
                <FormField label="IP Address / Host" hint="Optional — set in Network → OLT for live status probe.">
                  <input className="input font-mono" value={editNap.host || ''} onChange={(e) => setEditNap({ ...editNap, host: e.target.value })} placeholder="192.168.1.10" />
                </FormField>
                <div className="grid grid-cols-2 gap-3 items-end">
                  <FormField label="Status">
                    <select className="input" value={editNap.status || 'active'} onChange={(e) => setEditNap({ ...editNap, status: e.target.value })}>
                      <option value="active">active</option>
                      <option value="online">online</option>
                      <option value="offline">offline</option>
                      <option value="inactive">inactive</option>
                    </select>
                  </FormField>
                  <button type="button" className="btn-secondary text-sm inline-flex items-center justify-center gap-1.5 h-[42px]" onClick={() => setPickFor('nap')}>
                    <MapPin size={14} /> Pick on Map
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <FormField label="PON Ports">
                    <input className="input" type="number" value={editNap.ports ?? 8} onChange={(e) => setEditNap({ ...editNap, ports: Number(e.target.value) })} />
                  </FormField>
                  <FormField label="PON Tx Power (dBm)" hint="Origin power for downstream budget math. Typical GPON: +3 to +7.">
                    <input className="input" type="number" step="0.1" value={editNap.txDbm ?? ''} onChange={(e) => setEditNap({ ...editNap, txDbm: e.target.value === '' ? null : Number(e.target.value) })} />
                  </FormField>
                </div>
              </>
            )}
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Latitude">
                <input className="input font-mono text-sm" type="number" step="any" value={editNap.lat ?? ''} onChange={(e) => setEditNap({ ...editNap, lat: Number(e.target.value) })} />
              </FormField>
              <FormField label="Longitude">
                <input className="input font-mono text-sm" type="number" step="any" value={editNap.lng ?? ''} onChange={(e) => setEditNap({ ...editNap, lng: Number(e.target.value) })} />
              </FormField>
            </div>
            <FormField label="Address">
              <input className="input" value={editNap.address || ''} onChange={(e) => setEditNap({ ...editNap, address: e.target.value })} />
            </FormField>
          </div>
        </Modal>
      )}

      <MapLocationPicker
        open={!!pickFor || !!mapPickServer || !!mapPickClient}
        lat={mapPickServer ? mapPickServer.lat : mapPickClient ? mapPickClient.lat : pickLat}
        lng={mapPickServer ? mapPickServer.lng : mapPickClient ? mapPickClient.lng : pickLng}
        fallback={defaultCenter}
        onClose={() => { setPickFor(null); setMapPickServer(null); setMapPickClient(null); }}
        onConfirm={(lat, lng) => {
          if (mapPickServer) {
            saveServerMap(mapPickServer, lat, lng);
            return;
          }
          if (mapPickClient) {
            saveClientMap(mapPickClient, lat, lng);
            return;
          }
          if (pickFor === 'server' && editServer) setEditServer({ ...editServer, lat, lng });
          if (pickFor === 'nap' && editNap) setEditNap({ ...editNap, lat, lng });
          setPickFor(null);
        }}
      />
    </Layout>
  );
}

function resolveEndpoints(
  kind: RouteKind,
  fromId: number,
  toId: number,
  servers: ServerNode[],
  napsById: Record<number, Nap>,
  clients: Client[]
): [[number, number], [number, number]] | null {
  if (kind === 'server-olt') {
    const s = servers.find((x) => x.id === fromId);
    const o = napsById[toId];
    if (!s || !o) return null;
    return [[s.lat, s.lng], [o.lat, o.lng]];
  }
  if (kind === 'olt-nap' || kind === 'nap-nap') {
    const a = napsById[fromId];
    const b = napsById[toId];
    if (!a || !b) return null;
    return [[a.lat, a.lng], [b.lat, b.lng]];
  }
  const n = napsById[fromId];
  const c = clients.find((x) => x.id === toId);
  if (!n || !c) return null;
  return [[n.lat, n.lng], [c.lat, c.lng]];
}

function ClientPanel({
  client,
  onClose,
  onEditLocation,
  onEditRoute,
}: {
  client: Client;
  onClose: () => void;
  onEditLocation: () => void;
  onEditRoute: () => void;
}) {
  const state = clientState(client);
  const color = CLIENT_COLORS[state].fill;
  return (
    <div className="map-client-panel card shadow-xl border border-slate-200 p-4 animate-fade-in-up">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div>
          <div className="font-bold text-slate-900">{client.customer}</div>
          <div className="text-xs text-slate-500">{client.username} · {client.account}</div>
        </div>
        <button type="button" onClick={onClose} className="p-1 rounded-lg hover:bg-slate-100 text-slate-400"><X size={16} /></button>
      </div>
      <div className="text-sm space-y-1.5">
        <div><span className="text-slate-500">Status:</span> <b style={{ color }}>{state}</b></div>
        <div><span className="text-slate-500">Address:</span> {client.address || '—'}</div>
        <div><span className="text-slate-500">Location:</span> <span className="font-mono text-xs">{client.lat.toFixed(5)}, {client.lng.toFixed(5)}</span></div>
        <div><span className="text-slate-500">Plan:</span> {client.plan} · Due {client.due}</div>
        <div><span className="text-slate-500">Traffic:</span> Rx {fmtRate(client.rxBps)} · Tx {fmtRate(client.txBps)}</div>
        <div><span className="text-slate-500">Usage:</span> Rx {fmtGB(client.rxGB)} · Tx {fmtGB(client.txGB)}</div>
        <div className="pt-2 border-t border-slate-100 text-xs text-slate-500">
          <div>NAP: {client.napName} · OLT: {client.oltName}</div>
          <div className="mt-1 font-medium text-slate-700">{client.topology}</div>
        </div>
        <div className="pt-2 border-t border-slate-100 flex flex-wrap gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 border border-slate-200 rounded-lg hover:bg-slate-50 text-slate-700"
            onClick={onEditLocation}
          >
            <MapPin size={13} /> Edit Location
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 border border-slate-200 rounded-lg hover:bg-slate-50 text-slate-700"
            onClick={onEditRoute}
          >
            <Route size={13} /> Edit Cable Route
          </button>
        </div>
      </div>
    </div>
  );
}

function TopoPanel({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2"><Server size={14} className="text-brand-500" /> {title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}

function TopoRow({ name, sub, right }: { name: string; sub: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 py-2 border-b border-slate-100 last:border-0">
      <div className="min-w-0">
        <div className="text-sm font-medium text-slate-800 truncate">{name}</div>
        <div className="text-xs text-slate-400 truncate">{sub}</div>
      </div>
      <div className="shrink-0">{right}</div>
    </div>
  );
}

function SplitterModal({
  splitter,
  splitters,
  splitterRows,
  napChainById,
  olts,
  napNodes,
  onClose,
  onSaved,
}: {
  splitter: Partial<Splitter>;
  splitters: Splitter[];
  splitterRows: SplitterRefLike[];
  napChainById: Map<number, ChainNapLike>;
  olts: Nap[];
  napNodes: Nap[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<Partial<Splitter>>({ ...splitter });
  const [busy, setBusy] = useState(false);
  const isEdit = !!splitter.id;
  const isAsymmetric = isAsymmetricType(form.type);
  const set = (patch: Partial<Splitter>) => setForm((f) => ({ ...f, ...patch }));

  const originNap = form.originKind === 'nap' && form.originId ? napNodes.find((n) => n.id === form.originId) : null;
  const originSplitter = form.originKind === 'splitter' && form.originId ? splitters.find((s) => s.id === form.originId) : null;
  const originIsAsymmetric = isAsymmetricType(originNap?.splitterType) || isAsymmetricType(originSplitter?.type);

  /** Live dBm preview — overlays the in-progress edit onto the loaded splitter chain. */
  const splittersById = useMemo(() => new Map(splitters.map((s) => [s.id, s as SplitterLike])), [splitters]);
  const preview = useMemo(() => {
    if (!form.type || !form.ratio?.trim() || !form.originKind) return null;
    const previewId = splitter.id ?? -1;
    const merged = new Map(splittersById);
    merged.set(previewId, {
      id: previewId,
      name: form.name || 'New splitter',
      type: form.type as 'FBT' | 'PLC' | 'FBTC',
      ratio: form.ratio,
      ports: form.ports,
      originKind: form.originKind,
      originId: form.originId ?? null,
      fbtcLeg: form.fbtcLeg,
    });
    const inputDbm = resolveSplitterInputDbm(previewId, merged, napChainById, splitterRows);
    const ref = splitterRows.find(
      (r) => r.type === form.type && r.ratio === form.ratio && (form.type !== 'FBTC' || Number(r.ports) === Number(form.ports))
    );
    const throughDbm = ref && inputDbm != null ? inputDbm - ref.throughLossDb : null;
    const tapDbm = ref?.tapLossDb != null && inputDbm != null ? inputDbm - ref.tapLossDb : null;
    return { inputDbm, throughDbm, tapDbm, hasRef: !!ref };
  }, [form, splitter.id, splittersById, napChainById, splitterRows]);

  const save = async () => {
    if (!form.name?.trim() || !form.ratio?.trim()) return;
    setBusy(true);
    try {
      if (isEdit) await api.put(`/splitters/${splitter.id}`, form);
      else await api.post('/splitters', form);
      onSaved();
    } catch (e: any) {
      alert(e?.response?.data?.error || 'Could not save splitter');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isEdit ? 'Edit Splitter' : 'New Splitter'}
      onClose={onClose}
      footer={<ModalFooter onCancel={onClose} onConfirm={save} confirmLabel="Save Splitter" busy={busy} />}
    >
      <div className="space-y-3">
        <FormField label="Name" required>
          <input className="input" value={form.name || ''} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Splitter — Main St. pole 4" />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Type">
            <select
              className="input"
              value={form.type || 'PLC'}
              onChange={(e) => {
                const t = e.target.value as 'FBT' | 'PLC' | 'FBTC';
                const opts = splitterRatioOptions(splitterRows, t);
                const ratio = opts.includes(form.ratio || '') ? form.ratio : opts[0] || '';
                const ports = t === 'FBTC' && !FBTC_PORT_OPTIONS.includes(Number(form.ports)) ? 8 : form.ports;
                set({ type: t, ratio, ports });
              }}
            >
              <option value="PLC">PLC</option>
              <option value="FBT">FBT</option>
              <option value="FBTC">FBTC (tap cassette)</option>
            </select>
          </FormField>
          <FormField label="Ratio">
            <select className="input" value={form.ratio || ''} onChange={(e) => set({ ratio: e.target.value })}>
              {splitterRatioOptions(splitterRows, (form.type as 'FBT' | 'PLC' | 'FBTC') || 'PLC').map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </FormField>
        </div>
        {form.type === 'FBTC' && (
          <FormField label="Cassette Ports">
            <select className="input" value={FBTC_PORT_OPTIONS.includes(Number(form.ports)) ? (form.ports ?? 8) : 8} onChange={(e) => set({ ports: Number(e.target.value) })}>
              {FBTC_PORT_OPTIONS.map((p) => (
                <option key={p} value={p}>{p} ports</option>
              ))}
            </select>
          </FormField>
        )}
        <FormField label="Origin">
          <select
            className="input"
            value={form.originKind || 'olt'}
            onChange={(e) => {
              const kind = e.target.value as 'olt' | 'nap' | 'splitter';
              const defaultId =
                kind === 'olt' ? olts[0]?.id || null : kind === 'nap' ? napNodes[0]?.id || null : splitters.filter((s) => s.id !== splitter.id)[0]?.id || null;
              set({ originKind: kind, originId: defaultId });
            }}
          >
            <option value="olt">From OLT</option>
            <option value="nap">From NAP</option>
            <option value="splitter">From another Splitter</option>
          </select>
        </FormField>
        {form.originKind === 'olt' ? (
          <FormField label="OLT" required>
            <select className="input" value={form.originId || ''} onChange={(e) => set({ originId: e.target.value ? Number(e.target.value) : null })}>
              <option value="">— Select OLT —</option>
              {olts.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          </FormField>
        ) : form.originKind === 'nap' ? (
          <FormField label="NAP" required>
            <select className="input" value={form.originId || ''} onChange={(e) => set({ originId: e.target.value ? Number(e.target.value) : null })}>
              <option value="">— Select NAP —</option>
              {napNodes.map((n) => (
                <option key={n.id} value={n.id}>{n.code ? `${n.code} · ${n.name}` : n.name}</option>
              ))}
            </select>
          </FormField>
        ) : (
          <FormField label="Splitter" required hint="Cascade this splitter off another splitter's output.">
            <select className="input" value={form.originId || ''} onChange={(e) => set({ originId: e.target.value ? Number(e.target.value) : null })}>
              <option value="">— Select Splitter —</option>
              {splitters.filter((s) => s.id !== splitter.id).map((s) => (
                <option key={s.id} value={s.id}>{s.name} ({s.type} {s.ratio})</option>
              ))}
            </select>
          </FormField>
        )}
        {originIsAsymmetric && (
          <FormField label="Origin Connection" hint={`Which port of the origin (ratio ${(originNap?.splitterRatio || originSplitter?.ratio) || '—'}) this splitter is plugged into.`}>
            <select className="input" value={form.fbtcLeg || 'through'} onChange={(e) => set({ fbtcLeg: e.target.value === 'tap' ? 'tap' : 'through' })}>
              <option value="through">{ratioLegLabel(originNap?.splitterRatio || originSplitter?.ratio, 'through')}</option>
              <option value="tap">{ratioLegLabel(originNap?.splitterRatio || originSplitter?.ratio, 'tap')}</option>
            </select>
          </FormField>
        )}
        {preview && (
          <div className="flex items-center gap-4 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
            {isAsymmetric ? (
              <>
                <span className="text-slate-500">
                  Through (trunk continue): <span className="font-semibold text-slate-800">{preview.throughDbm != null ? `${preview.throughDbm.toFixed(2)} dBm` : '—'}</span>
                </span>
                <span className="text-slate-500">
                  Tap (subscriber drop): <span className="font-semibold text-slate-800">{preview.tapDbm != null ? `${preview.tapDbm.toFixed(2)} dBm` : '—'}</span>
                </span>
              </>
            ) : (
              <span className="text-slate-500">
                Output: <span className="font-semibold text-slate-800">{preview.throughDbm != null ? `${preview.throughDbm.toFixed(2)} dBm` : '—'}</span>
              </span>
            )}
            {!preview.hasRef && (
              <span className="text-amber-600">no reference match for this type/ratio</span>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
