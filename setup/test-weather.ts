/**
 * Test weather utilities
 *
 * Run: bun run setup/test-weather.ts
 */

import {
  getSingaporeWeather2Hr,
  getSingaporeWeatherOpenMeteo,
  getSingaporeWeather,
  getWeatherOpenMeteo,
} from "../src/utils/weather.ts";

console.log("Testing weather utilities...\n");

// Test 1: Singapore NEA
console.log("1. Testing Singapore NEA (data.gov.sg)...");
try {
  const nea = await getSingaporeWeather2Hr();
  console.log("✓ NEA:", nea);
} catch (error) {
  console.error("✗ NEA failed:", error);
}

// Test 2: Singapore Open-Meteo
console.log("\n2. Testing Singapore Open-Meteo...");
try {
  const meteo = await getSingaporeWeatherOpenMeteo();
  console.log("✓ Open-Meteo:", meteo);
} catch (error) {
  console.error("✗ Open-Meteo failed:", error);
}

// Test 3: Convenience wrapper (with fallback)
console.log("\n3. Testing convenience wrapper (NEA + fallback)...");
try {
  const weather = await getSingaporeWeather();
  console.log("✓ Convenience:", weather);
} catch (error) {
  console.error("✗ Convenience failed:", error);
}

// Test 4: Generic Open-Meteo (New York example)
console.log("\n4. Testing generic Open-Meteo (New York)...");
try {
  const ny = await getWeatherOpenMeteo(40.7128, -74.006, "America/New_York");
  console.log("✓ New York:", ny);
} catch (error) {
  console.error("✗ New York failed:", error);
}

console.log("\nWeather utilities test complete!");
