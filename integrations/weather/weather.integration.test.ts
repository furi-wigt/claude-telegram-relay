/**
 * Weather Integration — integration tests (real NEA API).
 * Run: RUN_INTEGRATION_TESTS=1 bun test integrations/weather/weather.integration.test.ts
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { createWeatherClient, type WeatherClient } from "./index.ts";

const SKIP = !process.env.RUN_INTEGRATION_TESTS;

describe.skipIf(SKIP)("weather integration", () => {
  let weather: WeatherClient;

  beforeAll(() => {
    weather = createWeatherClient();
  });

  test("createWeatherClient() returns a client", () => {
    expect(weather).not.toBeNull();
    expect(weather).toBeDefined();
    expect(typeof weather.getSingaporeWeather).toBe("function");
  });

  test("getSingaporeWeather() returns a non-empty string", async () => {
    const result = await weather.getSingaporeWeather();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  }, 15_000);

  test("get2HourForecast() returns array with area forecasts", async () => {
    const result = await weather.get2HourForecast();
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toHaveProperty("area");
    expect(result[0]).toHaveProperty("forecast");
  }, 15_000);

  test("get24HourForecast() returns object with general and periods", async () => {
    const result = await weather.get24HourForecast();
    expect(result).toHaveProperty("general");
    expect(result).toHaveProperty("periods");
    expect(result.general).toHaveProperty("forecast");
    expect(result.general).toHaveProperty("temperature");
    expect(Array.isArray(result.periods)).toBe(true);
  }, 15_000);

  test("getPSI() returns object with national number >= 0", async () => {
    const result = await weather.getPSI();
    expect(result).toHaveProperty("national");
    expect(typeof result.national).toBe("number");
    expect(result.national).toBeGreaterThanOrEqual(0);
  }, 15_000);

  test("getUVIndex() returns object with index number >= 0", async () => {
    const result = await weather.getUVIndex();
    expect(result).toHaveProperty("index");
    expect(typeof result.index).toBe("number");
    expect(result.index).toBeGreaterThanOrEqual(0);
  }, 15_000);

  test("getMorningSummary() returns all expected fields", async () => {
    const result = await weather.getMorningSummary();
    expect(result).toHaveProperty("current");
    expect(result).toHaveProperty("forecast24h");
    expect(result).toHaveProperty("airQuality");
    expect(result).toHaveProperty("uvIndex");
    expect(typeof result.current).toBe("string");
    expect(typeof result.forecast24h).toBe("string");
    expect(typeof result.airQuality).toBe("string");
    expect(typeof result.uvIndex).toBe("number");
  }, 15_000);
});
