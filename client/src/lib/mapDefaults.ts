/** Fallback map center when no saved default / OLT / server location exists. */
export const FALLBACK_MAP_LAT = 13.918665341879885;
export const FALLBACK_MAP_LNG = 120.93887161534413;
export const FALLBACK_MAP_CENTER: [number, number] = [FALLBACK_MAP_LAT, FALLBACK_MAP_LNG];

export type MapDefaultCenter = { lat: number; lng: number };

export function normalizeMapCenter(lat: unknown, lng: unknown): MapDefaultCenter {
  const la = Number(lat);
  const ln = Number(lng);
  return {
    lat: Number.isFinite(la) ? la : FALLBACK_MAP_LAT,
    lng: Number.isFinite(ln) ? ln : FALLBACK_MAP_LNG,
  };
}
