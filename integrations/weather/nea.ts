/**
 * NEA Weather — Singapore data.gov.sg v2 API endpoints.
 * No API key required (public tier: 6 req/10s).
 * Optional: set DATA_GOV_SG_API_KEY for higher rate limits.
 *
 * All responses are cached in-memory with TTL to respect rate limits.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AreaForecast {
  area: string;
  forecast: string;
}

export interface DayForecast24 {
  general: {
    forecast: string;
    temperature: { low: number; high: number };
    humidity: { low: number; high: number };
  };
  periods: Array<{
    timePeriod: string;
    regions: {
      north: string;
      south: string;
      east: string;
      west: string;
      central: string;
    };
  }>;
}

export interface DayForecast {
  date: string;
  forecast: string;
  temperature: { low: number; high: number };
  humidity: { low: number; high: number };
  wind: { speed: { low: number; high: number }; direction: string };
}

export interface PSIReading {
  national: number;
  north: number;
  south: number;
  east: number;
  west: number;
  central: number;
  pm25_national?: number;
  timestamp: Date;
}

export interface UVReading {
  index: number;
  category: 'low' | 'moderate' | 'high' | 'very-high' | 'extreme';
  timestamp: Date;
}

export interface StationAverage {
  average: number;
  min: number;
  max: number;
  unit: string;
}

export interface RainfallReading {
  stationId: string;
  stationName: string;
  value: number; // mm
}

// ── Cache ─────────────────────────────────────────────────────────────────────

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string): T | undefined {
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.data;
}

function setCached<T>(key: string, data: T, ttlMs: number): void {
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

// ── Base fetch ────────────────────────────────────────────────────────────────

const BASE_URL = "https://api-open.data.gov.sg/v2/real-time/api";

async function neaFetch<T>(path: string, ttlMs: number): Promise<T> {
  const cached = getCached<T>(path);
  if (cached !== undefined) return cached;

  const headers: Record<string, string> = {};
  const apiKey = process.env.DATA_GOV_SG_API_KEY;
  if (apiKey) headers["x-api-key"] = apiKey;

  const res = await fetch(`${BASE_URL}${path}`, { headers });
  if (!res.ok) {
    throw new Error(`NEA API ${path} error: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as T;
  setCached(path, json, ttlMs);
  return json;
}

// ── TTL constants (ms) ────────────────────────────────────────────────────────

const TTL = {
  TWO_HR: 10 * 60 * 1000,        // 10 min
  TWENTY_FOUR_HR: 30 * 60 * 1000, // 30 min
  FOUR_DAY: 60 * 60 * 1000,      // 60 min
  PSI: 30 * 60 * 1000,           // 30 min
  UV: 30 * 60 * 1000,            // 30 min
  STATION: 5 * 60 * 1000,        // 5 min
};

// ── 2-hour forecast ───────────────────────────────────────────────────────────

interface TwoHrResponse {
  data?: {
    items?: Array<{
      forecasts?: Array<{ area: string; forecast: string }>;
    }>;
  };
}

export async function get2HourForecast(): Promise<AreaForecast[]> {
  const data = await neaFetch<TwoHrResponse>("/two-hr-forecast", TTL.TWO_HR);
  const forecasts = data.data?.items?.[0]?.forecasts ?? [];
  return forecasts.map(f => ({ area: f.area, forecast: f.forecast }));
}

// ── 24-hour forecast ──────────────────────────────────────────────────────────

interface TwentyFourHrResponse {
  data?: {
    records?: Array<{
      general?: {
        forecast?: { code?: string; text?: string };
        temperature?: { low?: number; high?: number };
        relativeHumidity?: { low?: number; high?: number };
      };
      periods?: Array<{
        timePeriod?: { text?: string };
        regions?: {
          north?: string;
          south?: string;
          east?: string;
          west?: string;
          central?: string;
        };
      }>;
    }>;
  };
}

export async function get24HourForecast(): Promise<DayForecast24> {
  const data = await neaFetch<TwentyFourHrResponse>("/twenty-four-hr-forecast", TTL.TWENTY_FOUR_HR);
  const item = data.data?.records?.[0];
  const general = item?.general ?? {};
  const periods = item?.periods ?? [];

  return {
    general: {
      forecast: general.forecast?.text ?? "Unknown",
      temperature: {
        low: general.temperature?.low ?? 0,
        high: general.temperature?.high ?? 0,
      },
      humidity: {
        low: general.relativeHumidity?.low ?? 0,
        high: general.relativeHumidity?.high ?? 0,
      },
    },
    periods: periods.map(p => ({
      timePeriod: p.timePeriod?.text ?? "",
      regions: {
        north: p.regions?.north ?? "",
        south: p.regions?.south ?? "",
        east: p.regions?.east ?? "",
        west: p.regions?.west ?? "",
        central: p.regions?.central ?? "",
      },
    })),
  };
}

// ── 4-day outlook ─────────────────────────────────────────────────────────────

interface FourDayResponse {
  data?: {
    items?: Array<{
      forecasts?: Array<{
        date?: string;
        forecast?: string;
        temperature?: { low?: number; high?: number };
        relativeHumidity?: { low?: number; high?: number };
        wind?: {
          speed?: { low?: number; high?: number };
          direction?: string;
        };
      }>;
    }>;
  };
}

export async function get4DayForecast(): Promise<DayForecast[]> {
  const data = await neaFetch<FourDayResponse>("/four-day-outlook", TTL.FOUR_DAY);
  const forecasts = data.data?.items?.[0]?.forecasts ?? [];

  return forecasts.map(f => ({
    date: f.date ?? "",
    forecast: f.forecast ?? "Unknown",
    temperature: { low: f.temperature?.low ?? 0, high: f.temperature?.high ?? 0 },
    humidity: { low: f.relativeHumidity?.low ?? 0, high: f.relativeHumidity?.high ?? 0 },
    wind: {
      speed: { low: f.wind?.speed?.low ?? 0, high: f.wind?.speed?.high ?? 0 },
      direction: f.wind?.direction ?? "",
    },
  }));
}

// ── PSI ───────────────────────────────────────────────────────────────────────

interface PSIResponse {
  data?: {
    items?: Array<{
      readings?: {
        psi_twenty_four_hourly?: {
          north?: number;
          south?: number;
          east?: number;
          west?: number;
          central?: number;
        };
        pm25_twenty_four_hourly?: {
          north?: number;
          south?: number;
          east?: number;
          west?: number;
          central?: number;
        };
      };
      timestamp?: string;
    }>;
  };
}

export async function getPSI(): Promise<PSIReading> {
  const data = await neaFetch<PSIResponse>("/psi", TTL.PSI);
  const item = data.data?.items?.[0];
  const psi = item?.readings?.psi_twenty_four_hourly ?? {};
  const pm25 = item?.readings?.pm25_twenty_four_hourly ?? {};

  const north = psi.north ?? 0;
  const south = psi.south ?? 0;
  const east = psi.east ?? 0;
  const west = psi.west ?? 0;
  const central = psi.central ?? 0;
  const national = Math.max(north, south, east, west, central);

  const pm25_north = pm25.north ?? 0;
  const pm25_south = pm25.south ?? 0;
  const pm25_east = pm25.east ?? 0;
  const pm25_west = pm25.west ?? 0;
  const pm25_central = pm25.central ?? 0;
  const pm25_national = Math.max(pm25_north, pm25_south, pm25_east, pm25_west, pm25_central) || undefined;

  return {
    national,
    north,
    south,
    east,
    west,
    central,
    pm25_national,
    timestamp: new Date(item?.timestamp ?? Date.now()),
  };
}

// ── PM2.5 ─────────────────────────────────────────────────────────────────────

interface PM25Response {
  data?: {
    items?: Array<{
      readings?: {
        pm25OneHourly?: { national?: number };
      };
      timestamp?: string;
    }>;
  };
}

export async function getPM25(): Promise<number> {
  const data = await neaFetch<PM25Response>("/pm25", TTL.PSI);
  return data.data?.items?.[0]?.readings?.pm25OneHourly?.national ?? 0;
}

// ── UV index ──────────────────────────────────────────────────────────────────

interface UVResponse {
  data?: {
    records?: Array<{
      index?: Array<{ value?: number }>;
      timestamp?: string;
    }>;
  };
}

function uvCategory(index: number): UVReading['category'] {
  if (index <= 2) return 'low';
  if (index <= 5) return 'moderate';
  if (index <= 7) return 'high';
  if (index <= 10) return 'very-high';
  return 'extreme';
}

export async function getUVIndex(): Promise<UVReading> {
  const data = await neaFetch<UVResponse>("/uv", TTL.UV);
  const record = data.data?.records?.[0];
  const index = record?.index?.[0]?.value ?? 0;

  return {
    index,
    category: uvCategory(index),
    timestamp: new Date(record?.timestamp ?? Date.now()),
  };
}

// ── Station-based readings ────────────────────────────────────────────────────

interface StationResponse {
  data?: {
    readings?: Array<{
      stationId?: string;
      value?: number;
    }>;
    stations?: Array<{
      id?: string;
      name?: string;
    }>;
  };
}

function computeStationAverage(readings: Array<{ value?: number }>, unit: string): StationAverage {
  const values = readings.map(r => r.value ?? 0).filter(v => isFinite(v));
  if (values.length === 0) return { average: 0, min: 0, max: 0, unit };
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    average: Math.round((sum / values.length) * 10) / 10,
    min: Math.min(...values),
    max: Math.max(...values),
    unit,
  };
}

export async function getAirTemperature(): Promise<StationAverage> {
  const data = await neaFetch<StationResponse>("/air-temperature", TTL.STATION);
  return computeStationAverage(data.data?.readings ?? [], "°C");
}

export async function getRelativeHumidity(): Promise<StationAverage> {
  const data = await neaFetch<StationResponse>("/relative-humidity", TTL.STATION);
  return computeStationAverage(data.data?.readings ?? [], "%");
}

export async function getWindSpeed(): Promise<StationAverage> {
  const data = await neaFetch<StationResponse>("/wind-speed", TTL.STATION);
  return computeStationAverage(data.data?.readings ?? [], "knots");
}

export async function getWindDirection(): Promise<number> {
  const data = await neaFetch<StationResponse>("/wind-direction", TTL.STATION);
  const readings = data.data?.readings ?? [];
  const values = readings.map(r => r.value ?? 0).filter(v => isFinite(v));
  if (values.length === 0) return 0;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

export async function getRainfall(): Promise<RainfallReading[]> {
  interface RainfallRaw {
    data?: {
      readings?: Array<{ stationId?: string; value?: number }>;
      stations?: Array<{ id?: string; name?: string }>;
    };
  }
  const data = await neaFetch<RainfallRaw>("/rainfall", TTL.STATION);
  const stations = data.data?.stations ?? [];
  const readings = data.data?.readings ?? [];

  const stationMap = new Map(stations.map(s => [s.id, s.name]));

  return readings
    .map(r => ({
      stationId: r.stationId ?? "",
      stationName: stationMap.get(r.stationId ?? "") ?? r.stationId ?? "",
      value: r.value ?? 0,
    }))
    .filter(r => r.value > 0)
    .sort((a, b) => b.value - a.value);
}
