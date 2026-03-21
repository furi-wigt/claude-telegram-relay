# Weather Integration

> Singapore weather data from NEA (data.gov.sg v2 API). No API key required. Provides forecasts, air quality, UV index, temperature, humidity, wind, and rainfall -- all cached in-memory to respect rate limits.

## Quick Start

```typescript
import { createWeatherClient } from 'integrations/weather';

const weather = createWeatherClient();
const morning = await weather.getMorningSummary();

console.log(morning.current);     // "Partly Cloudy (Day), 31°C"
console.log(morning.forecast24h); // "Thundery Showers (25-34°C)"
console.log(morning.airQuality);  // "PSI 42 (Good), PM2.5 12"
console.log(morning.uvIndex);     // 8
```

## Setup

**No API key required.** The NEA public tier allows 6 requests per 10 seconds.

**Optional environment variable:**
- `DATA_GOV_SG_API_KEY` -- For higher rate limits if you hit the public ceiling

All data comes from `https://api-open.data.gov.sg/v2/real-time/api/`.

## API Reference

### `createWeatherClient()` -> `WeatherClient`

Factory function. Always returns a client. No configuration needed.

### Methods

#### `getMorningSummary()` -> `Promise<{ current, forecast24h, airQuality, uvIndex }>`

All-in-one convenience method for morning briefing routines. Fetches weather, forecast, PSI, and UV in parallel using `Promise.allSettled` -- partial failures return fallback strings rather than throwing.

**Returns:**
- `current: string` -- Current conditions from Open-Meteo (e.g. `"Partly Cloudy (Day), 31°C"`)
- `forecast24h: string` -- 24-hour general forecast with temp range (e.g. `"Thundery Showers (25-34°C)"`)
- `airQuality: string` -- PSI level with classification and optional PM2.5 (e.g. `"PSI 42 (Good), PM2.5 12"`)
- `uvIndex: number` -- Current UV index (0 if unavailable)

**Example:**
```typescript
const { current, forecast24h, airQuality, uvIndex } = await weather.getMorningSummary();
const uvWarning = uvIndex >= 8 ? '\nUV is high -- wear sunscreen!' : '';
const message = `Weather: ${current}\nForecast: ${forecast24h}\nAir: ${airQuality}${uvWarning}`;
```

#### `getSingaporeWeather()` -> `Promise<string>`

Delegates to the existing `src/utils/weather.ts` Open-Meteo integration. Returns a formatted human-readable string of current Singapore conditions.

#### `get2HourForecast()` -> `Promise<AreaForecast[]>`

Short-term forecast broken down by area (e.g. Ang Mo Kio, Bedok, Changi).

**Returns:** Array of `{ area: string, forecast: string }` -- typically 40+ Singapore areas.

**Example:**
```typescript
const forecasts = await weather.get2HourForecast();
const ang_mo_kio = forecasts.find(f => f.area === 'Ang Mo Kio');
// { area: 'Ang Mo Kio', forecast: 'Partly Cloudy (Day)' }
```

#### `get24HourForecast()` -> `Promise<DayForecast24>`

Full 24-hour outlook with general forecast, temperature/humidity ranges, and regional period breakdowns.

**Returns:**
```typescript
{
  general: {
    forecast: string,           // "Thundery Showers"
    temperature: { low, high }, // { low: 25, high: 34 }
    humidity: { low, high },    // { low: 55, high: 95 }
  },
  periods: Array<{
    timePeriod: string,  // "Morning", "Afternoon", etc.
    regions: { north, south, east, west, central },  // forecast per region
  }>
}
```

#### `get4DayForecast()` -> `Promise<DayForecast[]>`

Extended 4-day outlook. Each day includes forecast, temperature, humidity, and wind.

**Returns:** Array of:
```typescript
{
  date: string,                          // "2026-02-21"
  forecast: string,                      // "Partly Cloudy"
  temperature: { low: number, high: number },
  humidity: { low: number, high: number },
  wind: { speed: { low, high }, direction: string },
}
```

#### `getPSI()` -> `Promise<PSIReading>`

24-hour PSI readings by region.

**Returns:**
```typescript
{
  national: number,
  north: number, south: number, east: number, west: number, central: number,
  pm25_national?: number,  // may be undefined
  timestamp: Date,
}
```

#### `getUVIndex()` -> `Promise<UVReading>`

Current UV index with human-readable category.

**Returns:** `{ index: number, category: 'low' | 'moderate' | 'high' | 'very-high' | 'extreme', timestamp: Date }`

#### `getAirTemperature()` -> `Promise<StationAverage>`

Aggregated air temperature across weather stations.

**Returns:** `{ average: number, min: number, max: number, unit: '°C' }`

#### `getRelativeHumidity()` -> `Promise<StationAverage>`

**Returns:** `{ average: number, min: number, max: number, unit: '%' }`

#### `getWindSpeed()` -> `Promise<StationAverage>`

**Returns:** `{ average: number, min: number, max: number, unit: 'knots' }`

#### `getWindDirection()` -> `Promise<number>`

Average wind direction in degrees across all stations.

#### `getRainfall()` -> `Promise<RainfallReading[]>`

Current rainfall readings. Only stations with non-zero rainfall are returned, sorted highest first.

**Returns:** Array of `{ stationId: string, stationName: string, value: number }` where value is in mm.

#### `getPM25()` -> `Promise<number>`

National 1-hour PM2.5 reading. Standalone export for convenience.

## Usage Patterns in Routines

### Morning Briefing

```typescript
import { createWeatherClient } from 'integrations/weather';
import { createTelegramClient } from 'integrations/telegram';

const weather = createWeatherClient();
const tg = createTelegramClient();
const chatId = Number(process.env.TELEGRAM_USER_ID);

const { current, forecast24h, airQuality, uvIndex } = await weather.getMorningSummary();

let msg = `Good morning!\n\nWeather: ${current}\nForecast: ${forecast24h}\nAir quality: ${airQuality}`;
if (uvIndex >= 8) msg += `\nUV index: ${uvIndex} -- wear sunscreen!`;

await tg.dispatch(chatId, { type: 'text', text: msg }, 'morning-summary');
```

### Rain Alert

```typescript
const rainfall = await weather.getRainfall();
if (rainfall.length > 0) {
  const top3 = rainfall.slice(0, 3).map(r => `${r.stationName}: ${r.value}mm`).join('\n');
  await tg.dispatch(chatId, {
    type: 'alert',
    text: `It is raining:\n${top3}`,
    severity: 'info',
  }, 'rain-alert');
}
```

### Weekly Weather Outlook

```typescript
const days = await weather.get4DayForecast();
const outlook = days.map(d =>
  `${d.date}: ${d.forecast} (${d.temperature.low}-${d.temperature.high}°C)`
).join('\n');
```

## Error Handling

Individual API calls throw on HTTP errors:

```typescript
try {
  const psi = await weather.getPSI();
} catch (err) {
  // "NEA API /psi error: 429 Too Many Requests"
}
```

`getMorningSummary()` uses `Promise.allSettled` and returns fallback strings instead of throwing. This is the safest method to call from routines.

## Limitations

- **Singapore only.** All data is from NEA and covers Singapore exclusively.
- **Rate limit:** 6 requests per 10 seconds on the public tier. The in-memory cache (TTLs from 5 to 60 minutes per endpoint) keeps you well under this for normal routine usage.
- **Cache is in-memory.** Restarting the process clears the cache. This is fine -- the cache is only for rate-limit protection, not persistence.
- **No historical data.** All endpoints return current/forecast data only.
- **UV index may be 0 at night** -- this is expected, not an error.
- **PM2.5 field on PSIReading** (`pm25_national`) may be `undefined` if the NEA response omits it.
