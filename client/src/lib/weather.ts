/**
 * Current weather for OLT/server map markers, via Open-Meteo (free, no API key,
 * CORS-enabled — https://open-meteo.com/en/docs). Client-side only: each
 * customer's own browser fetches directly, so this never touches the panel's
 * server or its egress policy.
 */

export interface WeatherNow {
  tempC: number;
  windKph: number;
  humidityPct: number;
  code: number;
  emoji: string;
  label: string;
  observedAt: string;
}

/** WMO weather-code → icon/label (https://open-meteo.com/en/docs — "WMO Weather interpretation codes"). */
const WMO_CODES: Record<number, { emoji: string; label: string }> = {
  0: { emoji: '☀️', label: 'Clear sky' },
  1: { emoji: '🌤️', label: 'Mainly clear' },
  2: { emoji: '⛅', label: 'Partly cloudy' },
  3: { emoji: '☁️', label: 'Overcast' },
  45: { emoji: '🌫️', label: 'Fog' },
  48: { emoji: '🌫️', label: 'Depositing rime fog' },
  51: { emoji: '🌦️', label: 'Light drizzle' },
  53: { emoji: '🌦️', label: 'Drizzle' },
  55: { emoji: '🌦️', label: 'Dense drizzle' },
  56: { emoji: '🌧️', label: 'Freezing drizzle' },
  57: { emoji: '🌧️', label: 'Dense freezing drizzle' },
  61: { emoji: '🌧️', label: 'Slight rain' },
  63: { emoji: '🌧️', label: 'Rain' },
  65: { emoji: '🌧️', label: 'Heavy rain' },
  66: { emoji: '🌧️', label: 'Freezing rain' },
  67: { emoji: '🌧️', label: 'Heavy freezing rain' },
  71: { emoji: '🌨️', label: 'Slight snow' },
  73: { emoji: '🌨️', label: 'Snow' },
  75: { emoji: '🌨️', label: 'Heavy snow' },
  77: { emoji: '🌨️', label: 'Snow grains' },
  80: { emoji: '🌦️', label: 'Slight rain showers' },
  81: { emoji: '🌧️', label: 'Rain showers' },
  82: { emoji: '⛈️', label: 'Violent rain showers' },
  85: { emoji: '🌨️', label: 'Slight snow showers' },
  86: { emoji: '🌨️', label: 'Heavy snow showers' },
  95: { emoji: '⛈️', label: 'Thunderstorm' },
  96: { emoji: '⛈️', label: 'Thunderstorm, slight hail' },
  99: { emoji: '⛈️', label: 'Thunderstorm, heavy hail' },
};

export function weatherIcon(code: number): { emoji: string; label: string } {
  return WMO_CODES[code] || { emoji: '🌡️', label: 'Unknown' };
}

/** ~1.1km buckets — enough to dedupe OLTs/servers on the same site without masking real distances. */
function cacheKey(lat: number, lng: number): string {
  return `${lat.toFixed(2)},${lng.toFixed(2)}`;
}

const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map<string, { at: number; data: WeatherNow | null }>();
const inFlight = new Map<string, Promise<WeatherNow | null>>();

export async function fetchCurrentWeather(lat: number, lng: number): Promise<WeatherNow | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const key = cacheKey(lat, lng);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const p = (async () => {
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,wind_speed_10m,relative_humidity_2m,weather_code&timezone=auto`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`weather ${res.status}`);
      const json = await res.json();
      const cur = json?.current;
      if (!cur) return null;
      const code = Number(cur.weather_code);
      const { emoji, label } = weatherIcon(code);
      const data: WeatherNow = {
        tempC: Number(cur.temperature_2m),
        windKph: Number(cur.wind_speed_10m),
        humidityPct: Number(cur.relative_humidity_2m),
        code,
        emoji,
        label,
        observedAt: String(cur.time || ''),
      };
      cache.set(key, { at: Date.now(), data });
      return data;
    } catch {
      cache.set(key, { at: Date.now(), data: null });
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, p);
  return p;
}
