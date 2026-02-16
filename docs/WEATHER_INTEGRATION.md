# Weather Integration

Weather utilities for the Claude Telegram Relay, providing no-API-key weather data from Singapore NEA and Open-Meteo.

## Available Functions

### Singapore-Specific

```typescript
import { getSingaporeWeather2Hr, getSingaporeWeather } from "./src/utils/weather.ts";

// NEA 2-hour forecast (most accurate for Singapore)
const forecast = await getSingaporeWeather2Hr();
// → "Singapore 2-hour forecast: Cloudy"

// Convenience wrapper with fallback
const weather = await getSingaporeWeather();
// → Tries NEA first, falls back to Open-Meteo
```

### Global (Open-Meteo)

```typescript
import { getWeatherOpenMeteo } from "./src/utils/weather.ts";

// Any location by coordinates
const nyWeather = await getWeatherOpenMeteo(
  40.7128,  // latitude
  -74.006,  // longitude
  "America/New_York"  // timezone
);
// → "Temperature: -0.4°C, wind 15.5 km/h (code 3) at 2026-02-16T09:30"
```

## Data Sources

### Singapore NEA (data.gov.sg)
- **URL**: `https://api.data.gov.sg/v1/environment/2-hour-weather-forecast`
- **Coverage**: Singapore only
- **API Key**: Not required
- **Data**: 2-hour forecast by region, aggregated to most common condition
- **Reference**: [data.gov.sg weather APIs](https://data.gov.sg/collections/1459/view)

### Open-Meteo
- **URL**: `https://api.open-meteo.com/v1/forecast`
- **Coverage**: Global
- **API Key**: Not required
- **Data**: Current temperature, wind speed, weather code, timestamp
- **Reference**: [open-meteo.com](https://open-meteo.com)

## Integration with Bot

To add weather to your bot's capabilities:

### Option 1: Direct Response

```typescript
import { getSingaporeWeather } from "./src/utils/weather.ts";

// In relay.ts text handler
const text = ctx.message.text;
if (text.toLowerCase().includes("weather")) {
  const weather = await getSingaporeWeather();
  await ctx.reply(weather);
  return;
}
```

### Option 2: Context Enhancement

Add weather to the prompt context so Claude can reference it naturally:

```typescript
import { getSingaporeWeather } from "./src/utils/weather.ts";

// In relay.ts, before calling Claude
const weatherContext = await getSingaporeWeather().catch(() => "");
const enrichedPrompt = `${prompt}\n\n[Current weather: ${weatherContext}]`;
```

### Option 3: Scheduled Updates (Morning Briefing)

```typescript
// In examples/morning-briefing.ts
import { getSingaporeWeather } from "../src/utils/weather.ts";

const weather = await getSingaporeWeather();
const briefing = `Good morning! ${weather}\n\n[Rest of briefing...]`;
```

## Testing

```bash
# Run all weather tests
bun run test:weather

# Manual testing
bun run
> import { getSingaporeWeather } from "./src/utils/weather.ts"
> console.log(await getSingaporeWeather())
```

## Error Handling

All functions throw on network/API errors. Use try-catch or `.catch()`:

```typescript
// Safe with fallback
const weather = await getSingaporeWeather()
  .catch(() => "Weather unavailable");

// Safe with error logging
try {
  const weather = await getSingaporeWeather();
  console.log(weather);
} catch (error) {
  console.error("Weather fetch failed:", error);
}
```

## Weather Codes (Open-Meteo)

Common codes:
- `0`: Clear sky
- `1-3`: Mainly clear, partly cloudy, overcast
- `45, 48`: Fog
- `51-57`: Drizzle
- `61-67`: Rain
- `71-77`: Snow
- `80-82`: Rain showers
- `85-86`: Snow showers
- `95-99`: Thunderstorm

Full reference: [Open-Meteo Weather Codes](https://open-meteo.com/en/docs)

## Rate Limits

Both APIs are free and have generous limits:
- **NEA**: No documented limit (government API)
- **Open-Meteo**: 10,000 requests/day per IP

For production high-volume usage, consider caching responses (5-15 min cache is reasonable for weather).
