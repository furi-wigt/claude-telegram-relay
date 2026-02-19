/**
 * Weather Integration — Singapore NEA + Open-Meteo.
 *
 * No API key required (public NEA tier: 6 req/10s).
 * Optionally set DATA_GOV_SG_API_KEY for higher rate limits.
 *
 * Usage:
 *   const weather = createWeatherClient();
 *   const morning = await weather.getMorningSummary();
 *   console.log(morning.current, morning.forecast24h);
 *
 *   const psi = await weather.getPSI();
 *   console.log(`National PSI: ${psi.national}`);
 */

import {
  get2HourForecast,
  get24HourForecast,
  get4DayForecast,
  getPSI,
  getPM25,
  getUVIndex,
  getAirTemperature,
  getRelativeHumidity,
  getWindSpeed,
  getWindDirection,
  getRainfall,
  type AreaForecast,
  type DayForecast24,
  type DayForecast,
  type PSIReading,
  type UVReading,
  type StationAverage,
  type RainfallReading,
} from "./nea.ts";

import { getSingaporeWeather } from "../../src/utils/weather.ts";

export type {
  AreaForecast,
  DayForecast24,
  DayForecast,
  PSIReading,
  UVReading,
  StationAverage,
  RainfallReading,
};

export interface WeatherClient {
  // Existing (delegates to src/utils/weather.ts)
  getSingaporeWeather(): Promise<string>;

  // Forecasts
  get2HourForecast(): Promise<AreaForecast[]>;
  get24HourForecast(): Promise<DayForecast24>;
  get4DayForecast(): Promise<DayForecast[]>;

  // Air quality & comfort
  getPSI(): Promise<PSIReading>;
  getUVIndex(): Promise<UVReading>;
  getAirTemperature(): Promise<StationAverage>;
  getRelativeHumidity(): Promise<StationAverage>;
  getRainfall(): Promise<RainfallReading[]>;

  // Wind
  getWindSpeed(): Promise<StationAverage>;
  getWindDirection(): Promise<number>;

  // Convenience: all-in-one for morning briefing
  getMorningSummary(): Promise<{
    current: string;
    forecast24h: string;
    airQuality: string;
    uvIndex: number;
  }>;
}

export function createWeatherClient(): WeatherClient {
  return {
    getSingaporeWeather,
    get2HourForecast,
    get24HourForecast,
    get4DayForecast,
    getPSI,
    getUVIndex,
    getAirTemperature,
    getRelativeHumidity,
    getRainfall,
    getWindSpeed,
    getWindDirection,

    async getMorningSummary() {
      const [currentRes, forecast24Res, psiRes, uvRes] = await Promise.allSettled([
        getSingaporeWeather(),
        get24HourForecast(),
        getPSI(),
        getUVIndex(),
      ]);

      const current =
        currentRes.status === 'fulfilled'
          ? currentRes.value
          : 'Weather unavailable';

      const forecast24h =
        forecast24Res.status === 'fulfilled'
          ? forecast24Res.value.general.forecast +
            ` (${forecast24Res.value.general.temperature.low}–${forecast24Res.value.general.temperature.high}°C)`
          : 'Forecast unavailable';

      let airQuality = 'Air quality unavailable';
      if (psiRes.status === 'fulfilled') {
        const psi = psiRes.value;
        const level =
          psi.national <= 50 ? 'Good' :
          psi.national <= 100 ? 'Moderate' :
          psi.national <= 200 ? 'Unhealthy' : 'Very Unhealthy';
        airQuality = `PSI ${psi.national} (${level})`;
        if (psi.pm25_national !== undefined) {
          airQuality += `, PM2.5 ${psi.pm25_national}`;
        }
      }

      const uvIndex =
        uvRes.status === 'fulfilled' ? uvRes.value.index : 0;

      return { current, forecast24h, airQuality, uvIndex };
    },
  };
}

// Re-export getPM25 for convenience
export { getPM25 };
