/**
 * Weather Utilities
 *
 * Provides weather fetching from:
 * 1. Singapore NEA via data.gov.sg (no API key)
 * 2. Open-Meteo global API (no API key)
 */

// ============================================================
// TYPES
// ============================================================

type ForecastArea = {
  area: string;
  forecast: string;
};

type ForecastItem = {
  update_timestamp: string;
  timestamp: string;
  valid_period: {
    start: string;
    end: string;
  };
  forecasts: ForecastArea[];
};

type ForecastApiResponse = {
  items: ForecastItem[];
};

type CurrentWeather = {
  temperature: number;
  windspeed: number;
  weathercode: number;
  time: string;
};

type OpenMeteoResponse = {
  latitude: number;
  longitude: number;
  timezone: string;
  current_weather: CurrentWeather;
};

// ============================================================
// CONSTANTS
// ============================================================

const SINGAPORE_LAT = 1.3521;
const SINGAPORE_LON = 103.8198;

// ============================================================
// SINGAPORE NEA (data.gov.sg)
// ============================================================

/**
 * Get 2-hour weather forecast for Singapore from NEA via data.gov.sg.
 * No API key required.
 *
 * Returns: "Singapore 2-hour forecast: {most common forecast}"
 */
export async function getSingaporeWeather2Hr(): Promise<string> {
  const url = "https://api.data.gov.sg/v1/environment/2-hour-weather-forecast";

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Weather API error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as ForecastApiResponse;

  if (!data.items?.length) {
    throw new Error("No forecast items returned from API");
  }

  const latest = data.items[0];

  // Aggregate forecasts and pick most common description
  const counts = new Map<string, number>();
  for (const f of latest.forecasts) {
    counts.set(f.forecast, (counts.get(f.forecast) ?? 0) + 1);
  }

  let bestForecast = "Unknown";
  let bestCount = 0;
  for (const [forecast, count] of counts) {
    if (count > bestCount) {
      bestForecast = forecast;
      bestCount = count;
    }
  }

  return `Singapore 2-hour forecast: ${bestForecast}`;
}

// ============================================================
// OPEN-METEO (Global)
// ============================================================

/**
 * Get current weather for Singapore from Open-Meteo.
 * No API key required.
 *
 * Returns: "Current temperature in Singapore: {temp}°C, wind {speed} km/h (code {code}) at {time}"
 */
export async function getSingaporeWeatherOpenMeteo(): Promise<string> {
  const params = new URLSearchParams({
    latitude: SINGAPORE_LAT.toString(),
    longitude: SINGAPORE_LON.toString(),
    current_weather: "true",
    timezone: "Asia/Singapore",
  });

  const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Weather API error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as OpenMeteoResponse;

  const cw = data.current_weather;
  return `Current temperature in Singapore: ${cw.temperature}°C, wind ${cw.windspeed} km/h (code ${cw.weathercode}) at ${cw.time}`;
}

/**
 * Get weather for any location using Open-Meteo.
 * No API key required.
 *
 * @param lat - Latitude
 * @param lon - Longitude
 * @param timezone - IANA timezone string (e.g., "Asia/Singapore")
 * @returns Weather description string
 */
export async function getWeatherOpenMeteo(
  lat: number,
  lon: number,
  timezone: string = "auto"
): Promise<string> {
  const params = new URLSearchParams({
    latitude: lat.toString(),
    longitude: lon.toString(),
    current_weather: "true",
    timezone,
  });

  const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Weather API error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as OpenMeteoResponse;

  const cw = data.current_weather;
  return `Temperature: ${cw.temperature}°C, wind ${cw.windspeed} km/h (code ${cw.weathercode}) at ${cw.time}`;
}

// ============================================================
// CONVENIENCE WRAPPER
// ============================================================

/**
 * Get Singapore weather using the preferred provider.
 * Tries NEA first (more accurate for Singapore), falls back to Open-Meteo.
 */
export async function getSingaporeWeather(): Promise<string> {
  try {
    return await getSingaporeWeather2Hr();
  } catch (error) {
    console.warn("NEA API failed, falling back to Open-Meteo:", error);
    return await getSingaporeWeatherOpenMeteo();
  }
}
