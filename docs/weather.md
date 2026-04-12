# Weather Integration

Weather utilities for the Claude Telegram Relay. Two layers: a rich Singapore NEA client (`integrations/weather`) and lightweight utility functions (`src/utils/weather.ts`). No API keys required for either.

## Quick Reference

| Function / Method | Source | Purpose | Example Output |
|---|---|---|---|
| `getSingaporeWeather()` | `src/utils/weather.ts` | Singapore (NEA + Open-Meteo fallback) | `"Singapore 2-hour forecast: Cloudy"` |
| `getSingaporeWeather2Hr()` | `src/utils/weather.ts` | Singapore NEA 2-hour only | `"Singapore 2-hour forecast: Cloudy"` |
| `getSingaporeWeatherOpenMeteo()` | `src/utils/weather.ts` | Singapore via Open-Meteo | `"Current temperature in Singapore: 25.3°C, wind 4.2 km/h..."` |
| `getWeatherOpenMeteo(lat, lon, tz)` | `src/utils/weather.ts` | Any location by coordinates | `"Temperature: -0.4°C, wind 15.5 km/h..."` |
| `createWeatherClient()` | `integrations/weather` | Full NEA v2 client (forecasts, PSI, UV, rainfall) | See below |

```bash
bun run test:weather  # Run all weather tests
```

## Singapore NEA Client

The `integrations/weather` module wraps the NEA data.gov.sg **v2** API with in-memory caching, `Promise.allSettled` resilience, and typed return values.

```typescript
import { createWeatherClient } from 'integrations/weather';

const weather = createWeatherClient();
```

No configuration needed. Optionally set `DATA_GOV_SG_API_KEY` for higher rate limits.

### `getMorningSummary()`

All-in-one convenience method for morning briefing routines. Fetches weather, forecast, PSI, and UV in parallel -- partial failures return fallback strings rather than throwing.

```typescript
const { current, forecast24h, airQuality, uvIndex } = await weather.getMorningSummary();

console.log(current);     // "Partly Cloudy (Day), 31°C"
console.log(forecast24h); // "Thundery Showers (25-34°C)"
console.log(airQuality);  // "PSI 42 (Good), PM2.5 12"
console.log(uvIndex);     // 8
```

**Returns:**
- `current: string` -- Current conditions from Open-Meteo
- `forecast24h: string` -- 24-hour general forecast with temp range
- `airQuality: string` -- PSI level with classification and optional PM2.5
- `uvIndex: number` -- Current UV index (0 if unavailable or nighttime)

### `get2HourForecast()` -> `AreaForecast[]`

Short-term forecast broken down by area (40+ Singapore areas).

```typescript
const forecasts = await weather.get2HourForecast();
const amk = forecasts.find(f => f.area === 'Ang Mo Kio');
// { area: 'Ang Mo Kio', forecast: 'Partly Cloudy (Day)' }
```

### `get24HourForecast()` -> `DayForecast24`

Full 24-hour outlook with general forecast, temperature/humidity ranges, and regional period breakdowns.

```typescript
const outlook = await weather.get24HourForecast();
// outlook.general.forecast    → "Thundery Showers"
// outlook.general.temperature → { low: 25, high: 34 }
// outlook.periods[0].regions  → { north, south, east, west, central }
```

### `get4DayForecast()` -> `DayForecast[]`

Extended 4-day outlook. Each day includes forecast, temperature, humidity, and wind.

```typescript
const days = await weather.get4DayForecast();
const outlook = days.map(d =>
  `${d.date}: ${d.forecast} (${d.temperature.low}-${d.temperature.high}°C)`
).join('\n');
```

### `getPSI()` -> `PSIReading`

24-hour PSI readings by region. `pm25_national` may be `undefined` if the NEA response omits it.

```typescript
const psi = await weather.getPSI();
// { national: 42, north: 38, south: 45, ..., pm25_national: 12, timestamp: Date }
```

### `getUVIndex()` -> `UVReading`

```typescript
const uv = await weather.getUVIndex();
// { index: 8, category: 'high', timestamp: Date }
```

### Station Readings

| Method | Returns |
|---|---|
| `getAirTemperature()` | `{ average, min, max, unit: '°C' }` |
| `getRelativeHumidity()` | `{ average, min, max, unit: '%' }` |
| `getWindSpeed()` | `{ average, min, max, unit: 'knots' }` |
| `getWindDirection()` | Average wind direction in degrees |
| `getRainfall()` | Non-zero stations sorted highest first: `{ stationId, stationName, value }` |
| `getPM25()` | National 1-hour PM2.5 reading |

## Utility Functions

Lightweight functions in `src/utils/weather.ts` -- no client instantiation needed.

### Singapore-Specific

```typescript
import { getSingaporeWeather2Hr, getSingaporeWeather } from "./src/utils/weather.ts";

// NEA 2-hour forecast (most accurate for Singapore)
const forecast = await getSingaporeWeather2Hr();
// → "Singapore 2-hour forecast: Cloudy"

// Convenience wrapper: tries NEA first, falls back to Open-Meteo
const weather = await getSingaporeWeather();
```

### Global (Open-Meteo)

```typescript
import { getWeatherOpenMeteo } from "./src/utils/weather.ts";

const nyWeather = await getWeatherOpenMeteo(
  40.7128,  // latitude
  -74.006,  // longitude
  "America/New_York"
);
// → "Temperature: -0.4°C, wind 15.5 km/h (code 3) at 2026-02-16T09:30"
```

> **Refactor note:** Weather logic was previously duplicated in each routine (~70 lines per routine). It has been centralised into `src/utils/weather.ts` with a simplified `{ summary, timestamp }` interface. No `NEA_API_KEY` is needed.

## Data Sources

### Singapore NEA (data.gov.sg)
- **v1 URL**: `https://api.data.gov.sg/v1/environment/2-hour-weather-forecast` (used by `src/utils/weather.ts`)
- **v2 URL**: `https://api-open.data.gov.sg/v2/real-time/api/` (used by `integrations/weather`)
- **Coverage**: Singapore only
- **API Key**: Not required (optional `DATA_GOV_SG_API_KEY` for higher rate limits)
- **Reference**: [data.gov.sg weather APIs](https://data.gov.sg/collections/1459/view)

### Open-Meteo
- **URL**: `https://api.open-meteo.com/v1/forecast`
- **Coverage**: Global
- **API Key**: Not required
- **Data**: Current temperature, wind speed, weather code, timestamp
- **Reference**: [open-meteo.com](https://open-meteo.com)

### Weather Codes (Open-Meteo)

| Code | Condition |
|---|---|
| `0` | Clear sky |
| `1-3` | Mainly clear, partly cloudy, overcast |
| `45, 48` | Fog |
| `51-57` | Drizzle |
| `61-67` | Rain |
| `71-77` | Snow |
| `80-82` | Rain showers |
| `85-86` | Snow showers |
| `95-99` | Thunderstorm |

Full reference: [Open-Meteo Weather Codes](https://open-meteo.com/en/docs)

## Usage in Routines

### Morning Briefing (NEA Client)

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

### Context Enhancement (Utility Functions)

```typescript
import { getSingaporeWeather } from "./src/utils/weather.ts";

const weatherContext = await getSingaporeWeather().catch(() => "");
const enrichedPrompt = `${prompt}\n\n[Current weather: ${weatherContext}]`;
```

Set `WEATHER_AREAS=Your City,Another Area` in `.env` to show weather for specific areas in the morning summary.

## Error Handling & Rate Limits

### Error Handling

Individual NEA client methods throw on HTTP errors. `getMorningSummary()` uses `Promise.allSettled` and returns fallback strings instead of throwing -- this is the safest method to call from routines.

Utility functions also throw on network/API errors. Use try-catch or `.catch()`:

```typescript
// Safe with fallback value
const weather = await getSingaporeWeather()
  .catch(() => "Weather unavailable");

// Safe with error logging
try {
  const psi = await weather.getPSI();
} catch (err) {
  // "NEA API /psi error: 429 Too Many Requests"
}
```

### Rate Limits

| Source | Limit | Notes |
|---|---|---|
| NEA (data.gov.sg) | 6 req / 10 seconds (public tier) | In-memory cache (5-60 min TTL per endpoint) keeps usage well under this |
| Open-Meteo | 10,000 req / day per IP | No auth needed |

For high-volume use, cache responses for 5-15 minutes.

### Limitations

- NEA data covers **Singapore only**
- NEA client cache is in-memory -- restarting the process clears it (this is fine, it is only for rate-limit protection)
- No historical data -- all endpoints return current/forecast only
- UV index returns 0 at night (expected, not an error)

## Key Files

| File | Purpose |
|---|---|
| `src/utils/weather.ts` | Lightweight utility functions (NEA v1 + Open-Meteo) |
| `integrations/weather/` | Full NEA v2 client with caching |
| `setup/test-weather.ts` | Test script (`bun run test:weather`) |
