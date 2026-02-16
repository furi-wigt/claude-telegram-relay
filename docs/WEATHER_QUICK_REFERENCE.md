# Weather Quick Reference

## Import & Use

```typescript
import { getSingaporeWeather } from "./src/utils/weather.ts";

const weather = await getSingaporeWeather();
// → "Singapore 2-hour forecast: Cloudy"
```

## All Available Functions

| Function | Purpose | Example Output |
|----------|---------|----------------|
| `getSingaporeWeather()` | Singapore (NEA + fallback) | "Singapore 2-hour forecast: Cloudy" |
| `getSingaporeWeather2Hr()` | Singapore NEA only | "Singapore 2-hour forecast: Cloudy" |
| `getSingaporeWeatherOpenMeteo()` | Singapore Open-Meteo | "Current temperature in Singapore: 25.3°C, wind 4.2 km/h..." |
| `getWeatherOpenMeteo(lat, lon, tz)` | Any location | "Temperature: -0.4°C, wind 15.5 km/h..." |

## Test

```bash
bun run test:weather
```

## Integration Examples

### 1. Direct Bot Response

```typescript
// In src/relay.ts text handler
if (text.toLowerCase().includes("weather")) {
  const weather = await getSingaporeWeather();
  await ctx.reply(weather);
  return;
}
```

### 2. Context Enhancement

```typescript
// Add to Claude's context
const weatherContext = await getSingaporeWeather().catch(() => "");
const enrichedPrompt = `${prompt}\n\n[Weather: ${weatherContext}]`;
```

### 3. Morning Briefing (Already Integrated)

```typescript
// examples/morning-briefing.ts uses getSingaporeWeather()
const weather = await getWeather(); // Returns just "Cloudy"
```

## Error Handling

```typescript
// Safe with fallback value
const weather = await getSingaporeWeather()
  .catch(() => "Weather unavailable");

// With logging
try {
  const weather = await getSingaporeWeather();
} catch (error) {
  console.error("Weather failed:", error);
}
```

## No API Keys Required

Both data sources are free:
- Singapore NEA (data.gov.sg)
- Open-Meteo (global)

## Rate Limits

- NEA: No documented limit
- Open-Meteo: 10,000 req/day per IP

For high-volume use, cache for 5-15 minutes.

## Full Documentation

See `docs/WEATHER_INTEGRATION.md` for complete guide.
