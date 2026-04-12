import { describe, test, expect, mock } from "bun:test";
import type { RoutineContext } from "../src/jobs/executors/routineContext.ts";
import type { RoutineConfig } from "../src/routines/routineConfig.ts";

mock.module("../src/utils/routineMessage.ts", () => ({
  sendAndRecord: async () => {},
}));

mock.module("../src/config/groups.ts", () => ({
  GROUPS: {},
  validateGroup: () => false,
}));

mock.module("../src/config/userConfig.ts", () => ({
  USER_TIMEZONE: "Asia/Singapore",
  USER_NAME: "Test",
}));

function makeCtx(overrides?: Partial<RoutineContext>): RoutineContext {
  const cfg: RoutineConfig = {
    name: "etf-52week-screener",
    group: "OPERATIONS",
    schedule: "0 22 * * *",
    params: {},
  };
  return {
    name: "etf-52week-screener",
    params: {},
    config: cfg,
    send: async () => {},
    llm: async () => "",
    log: () => {},
    skipIfRanWithin: async () => false,
    ...overrides,
  };
}

describe("etf-52week-screener — pure functions", () => {
  test("calcRsi returns 50 for insufficient data", async () => {
    const { calcRsi } = await import("./handlers/etf-52week-screener.ts");
    expect(calcRsi([100, 101], 14)).toBe(50);
  });

  test("calcRsi returns 100 when only gains", async () => {
    const { calcRsi } = await import("./handlers/etf-52week-screener.ts");
    // All gains — avgLoss = 0 => RSI = 100
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    expect(calcRsi(closes, 14)).toBe(100);
  });

  test("calcRsi returns value between 0 and 100", async () => {
    const { calcRsi } = await import("./handlers/etf-52week-screener.ts");
    const closes = [100, 102, 101, 103, 102, 104, 103, 105, 104, 106, 105, 107, 106, 108, 107];
    const rsi = calcRsi(closes, 14);
    expect(rsi).toBeGreaterThanOrEqual(0);
    expect(rsi).toBeLessThanOrEqual(100);
  });

  test("formatPrice converts GBp to pounds", async () => {
    const { formatPrice } = await import("./handlers/etf-52week-screener.ts");
    expect(formatPrice(10050, "GBp")).toBe("£100.50");
  });

  test("formatPrice formats USD", async () => {
    const { formatPrice } = await import("./handlers/etf-52week-screener.ts");
    expect(formatPrice(123.45, "USD")).toBe("$123.45");
  });

  test("formatPrice formats SGD", async () => {
    const { formatPrice } = await import("./handlers/etf-52week-screener.ts");
    expect(formatPrice(3.50, "SGD")).toBe("S$3.50");
  });

  test("screenETFs returns empty breakouts and candidates for empty input", async () => {
    const { screenETFs } = await import("./handlers/etf-52week-screener.ts");
    const result = screenETFs([]);
    expect(result.breakouts).toHaveLength(0);
    expect(result.candidates).toHaveLength(0);
  });

  test("screenETFs filters out ETFs more than 5% below high", async () => {
    const { screenETFs } = await import("./handlers/etf-52week-screener.ts");
    const quotes = [
      {
        ticker: "A", name: "A", price: 90, high52w: 100,
        pctFromHigh: -10, currency: "USD", displayPrice: "$90",
        isBreakout: false, volumeConfirmed: false,
      },
      {
        ticker: "B", name: "B", price: 97, high52w: 100,
        pctFromHigh: -3, currency: "USD", displayPrice: "$97",
        isBreakout: false, volumeConfirmed: false,
      },
    ];
    const result = screenETFs(quotes);
    expect(result.breakouts).toHaveLength(0);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].ticker).toBe("B");
  });

  test("screenETFs separates volume-confirmed breakouts from candidates", async () => {
    const { screenETFs } = await import("./handlers/etf-52week-screener.ts");
    const quotes = [
      {
        ticker: "A", name: "A", price: 101, high52w: 100,
        pctFromHigh: 1, currency: "USD", displayPrice: "$101",
        isBreakout: true, volumeConfirmed: true,
      },
      {
        ticker: "B", name: "B", price: 101, high52w: 100,
        pctFromHigh: 1, currency: "USD", displayPrice: "$101",
        isBreakout: true, volumeConfirmed: false,
      },
      {
        ticker: "C", name: "C", price: 98, high52w: 100,
        pctFromHigh: -2, currency: "USD", displayPrice: "$98",
        isBreakout: false, volumeConfirmed: false,
      },
    ];
    const result = screenETFs(quotes);
    expect(result.breakouts).toHaveLength(1);
    expect(result.breakouts[0].ticker).toBe("A");
    expect(result.candidates).toHaveLength(2);
  });

  test("formatMessage includes VIX information when available", async () => {
    const { formatMessage } = await import("./handlers/etf-52week-screener.ts");
    const vix = { value: 15, regime: "bull" as const, label: "Bull Mode", emoji: "🟢" };
    const msg = formatMessage([], [], [], 55, vix);
    expect(msg).toContain("VIX 15.0");
    expect(msg).toContain("Bull Mode");
  });

  test("formatMessage shows 'None' when no confirmed breakouts", async () => {
    const { formatMessage } = await import("./handlers/etf-52week-screener.ts");
    const msg = formatMessage([], [], [], 55, null);
    expect(msg).toContain("None");
  });

  test("THRESHOLD_PCT is -5", async () => {
    const { THRESHOLD_PCT } = await import("./handlers/etf-52week-screener.ts");
    expect(THRESHOLD_PCT).toBe(-5);
  });

  test("ETF_UNIVERSE has more than 50 tickers", async () => {
    const { ETF_UNIVERSE } = await import("./handlers/etf-52week-screener.ts");
    expect(ETF_UNIVERSE.length).toBeGreaterThan(50);
  });
});

describe("etf-52week-screener run() — ctx contract", () => {
  test("run() calls ctx.log at least once", async () => {
    const logs: string[] = [];
    const ctx = makeCtx({
      log: (msg: string) => { logs.push(msg); },
    });

    const { run } = await import("./handlers/etf-52week-screener.ts");

    try {
      await run(ctx);
    } catch {
      // Network failure acceptable in test environment
    }

    expect(logs.length).toBeGreaterThan(0);
  });
});
