#!/usr/bin/env bun

/**
 * @routine weekly-etf
 * @description Weekly UCITS ETF portfolio analysis — 85/15 global/SG allocation using top-5 high-expectancy strategies
 * @schedule 0 17 * * 5
 * @target GENERAL group
 */

/**
 * Weekly ETF Analysis Routine
 *
 * Schedule: Friday 5:00 PM SGT — before weekend review
 * Target: General AI Assistant group
 *
 * Strategy:
 * - 85% Global (UCITS ETFs, IBKR LSE, prioritise lowest TER)
 * - 15% Singapore (SGX-listed ETFs)
 *
 * ETF selection scored against Top-5 High-Expectancy strategies:
 * 1. Global Equity Dual Momentum (GEM) — momentum signal via 12-month returns
 * 2. 200-Day SMA Timing — price vs 200DMA for trend filter
 * 3. RSI(2) Mean Reversion — deeply oversold buy signals within uptrend
 * 4. 3-ETF Relative Strength Rotation (Equities/Gold/Bonds) — composite momentum scoring
 * 5. Monthly Asset-Class Momentum Rotation — rank by 6-month performance
 *
 * Run manually: bun run routines/weekly-etf.ts
 */

import { sendAndRecord } from "../src/utils/routineMessage.ts";
import { GROUPS, validateGroup } from "../src/config/groups.ts";

// ============================================================
// UCITS ETF UNIVERSE (Ireland-domiciled, LSE-listed via IBKR)
// ============================================================

// Global (85%) — UCITS priority, lowest TER
const GLOBAL_UCITS_ETFS = [
  {
    ticker: "VWRA.L",
    yahooTicker: "VWRA.L",
    name: "Vanguard FTSE All-World Acc",
    ter: 0.22,
    description: "One-fund global solution (developed + EM)",
    role: "core-global",
  },
  {
    ticker: "CSPX.L",
    yahooTicker: "CSPX.L",
    name: "iShares Core S&P 500 Acc",
    ter: 0.07,
    description: "US large-cap S&P 500, ultra-low TER",
    role: "us-core",
  },
  {
    ticker: "VUAA.L",
    yahooTicker: "VUAA.L",
    name: "Vanguard S&P 500 Acc",
    ter: 0.07,
    description: "US S&P 500, Vanguard equivalent",
    role: "us-core",
  },
  {
    ticker: "IWDA.L",
    yahooTicker: "IWDA.L",
    name: "iShares Core MSCI World Acc",
    ter: 0.20,
    description: "Developed markets only, pairs with EIMI",
    role: "developed",
  },
  {
    ticker: "EIMI.L",
    yahooTicker: "EIMI.L",
    name: "iShares Core MSCI EM IMI Acc",
    ter: 0.18,
    description: "Emerging markets complement to IWDA",
    role: "em",
  },
  {
    ticker: "IITU.L",
    yahooTicker: "IITU.L",
    name: "iShares S&P 500 IT Sector Acc",
    ter: 0.15,
    description: "Technology tilt, UCITS",
    role: "sector-tech",
  },
  {
    ticker: "HEAL.L",
    yahooTicker: "HEAL.L",
    name: "iShares S&P 500 Health Care Acc",
    ter: 0.15,
    description: "Healthcare sector, defensive tilt",
    role: "sector-defensive",
  },
  {
    ticker: "IGLN.L",
    yahooTicker: "IGLN.L",
    name: "iShares Physical Gold ETC",
    ter: 0.12,
    description: "Gold — used in Relative Strength Rotation strategy",
    role: "alternative",
  },
  {
    ticker: "IDTM.L",
    yahooTicker: "IDTM.L",
    name: "iShares $ Treasury Bond 1-3yr Acc",
    ter: 0.07,
    description: "Short-duration bonds — absolute momentum safe haven",
    role: "bond-safety",
  },
];

// Singapore (15%) — SGX-listed
const SG_ETFS = [
  {
    ticker: "ES3.SI",
    yahooTicker: "ES3.SI",
    name: "SPDR STI ETF",
    ter: 0.30,
    description: "Straits Times Index 30 blue chips",
    role: "sg-equity",
  },
  {
    ticker: "A35.SI",
    yahooTicker: "A35.SI",
    name: "ABF SG Bond Index ETF",
    ter: 0.24,
    description: "SG govt bonds — absolute momentum safe haven",
    role: "sg-bond",
  },
  {
    ticker: "G3B.SI",
    yahooTicker: "G3B.SI",
    name: "Nikko AM SGD Investment Grade Corp Bond",
    ter: 0.35,
    description: "SG investment grade corp bonds",
    role: "sg-bond",
  },
];

// ============================================================
// YAHOO FINANCE DATA FETCHER
// ============================================================

interface QuoteData {
  ticker: string;
  yahooTicker: string;
  name: string;
  ter: number;
  description: string;
  role: string;
  price: number | null;
  prevClose: number | null;
  change: number | null;
  changePercent: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  ma200: number | null; // 200-day SMA (derived from 1y daily data)
  rsi2: number | null;  // 2-period RSI
  mom6m: number | null; // 6-month momentum %
  mom12m: number | null; // 12-month momentum %
}

async function fetchQuote(etf: {
  ticker: string;
  yahooTicker: string;
  name: string;
  ter: number;
  description: string;
  role: string;
}): Promise<QuoteData> {
  const fallback: QuoteData = {
    ...etf,
    price: null,
    prevClose: null,
    change: null,
    changePercent: null,
    fiftyTwoWeekHigh: null,
    fiftyTwoWeekLow: null,
    ma200: null,
    rsi2: null,
    mom6m: null,
    mom12m: null,
  };

  try {
    // Yahoo Finance v8 — 1 year daily data for SMA/momentum calc
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(etf.yahooTicker)}?range=1y&interval=1d`;
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(12000),
    });

    if (!response.ok) return fallback;

    const data = await response.json();
    const meta = data?.chart?.result?.[0]?.meta;
    const quotes = data?.chart?.result?.[0]?.indicators?.quote?.[0];

    if (!meta) return fallback;

    const currentPrice = meta.regularMarketPrice ?? null;
    const previousClose = meta.chartPreviousClose ?? meta.previousClose ?? null;

    let change: number | null = null;
    let changePercent: number | null = null;
    if (currentPrice != null && previousClose != null && previousClose !== 0) {
      change = currentPrice - previousClose;
      changePercent = (change / previousClose) * 100;
    }

    // Closes array for technical indicators
    const closes: number[] = (quotes?.close ?? []).filter((c: number | null) => c != null);

    // 200-day SMA
    let ma200: number | null = null;
    if (closes.length >= 200) {
      const last200 = closes.slice(-200);
      ma200 = last200.reduce((a, b) => a + b, 0) / 200;
    }

    // 2-period RSI
    let rsi2: number | null = null;
    if (closes.length >= 3) {
      const recent = closes.slice(-3);
      let gains = 0;
      let losses = 0;
      for (let i = 1; i < recent.length; i++) {
        const diff = recent[i] - recent[i - 1];
        if (diff > 0) gains += diff;
        else losses += Math.abs(diff);
      }
      const rs = losses === 0 ? 100 : gains / losses;
      rsi2 = 100 - 100 / (1 + rs);
    }

    // 6-month momentum (approx 126 trading days)
    let mom6m: number | null = null;
    if (closes.length >= 126 && currentPrice != null) {
      const price6mAgo = closes[closes.length - 126];
      mom6m = ((currentPrice - price6mAgo) / price6mAgo) * 100;
    }

    // 12-month momentum
    let mom12m: number | null = null;
    if (closes.length >= 252 && currentPrice != null) {
      const price12mAgo = closes[closes.length - 252];
      mom12m = ((currentPrice - price12mAgo) / price12mAgo) * 100;
    } else if (closes.length > 0 && currentPrice != null) {
      // Use what we have
      const oldest = closes[0];
      mom12m = ((currentPrice - oldest) / oldest) * 100;
    }

    return {
      ...etf,
      price: currentPrice,
      prevClose: previousClose,
      change,
      changePercent,
      fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? null,
      fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? null,
      ma200,
      rsi2,
      mom6m,
      mom12m,
    };
  } catch (error) {
    console.error(`Failed to fetch ${etf.ticker}:`, error);
    return fallback;
  }
}

async function fetchAllQuotes(etfs: typeof GLOBAL_UCITS_ETFS): Promise<QuoteData[]> {
  return Promise.all(etfs.map(fetchQuote));
}

// ============================================================
// STRATEGY SCORING
// ============================================================

/**
 * Score each ETF against the 5 high-expectancy strategies.
 * Returns a score 0-5 (one point per strategy signal).
 */
function scoreETF(q: QuoteData): { score: number; signals: string[] } {
  const signals: string[] = [];
  let score = 0;

  // Strategy 1: GEM — 12-month positive momentum (relative)
  if (q.mom12m != null && q.mom12m > 0) {
    score++;
    signals.push(`GEM✓ (+${q.mom12m.toFixed(1)}% 12m)`);
  }

  // Strategy 2: 200-DMA Timing — price above 200-day SMA
  if (q.price != null && q.ma200 != null && q.price > q.ma200) {
    score++;
    signals.push(`SMA200✓ (${((q.price / q.ma200 - 1) * 100).toFixed(1)}% above)`);
  }

  // Strategy 3: RSI(2) Mean Reversion — oversold within uptrend (buy signal)
  if (q.rsi2 != null && q.rsi2 < 15 && q.price != null && q.ma200 != null && q.price > q.ma200) {
    score++;
    signals.push(`RSI2✓ oversold(${q.rsi2.toFixed(0)})`);
  } else if (q.rsi2 != null && q.rsi2 > 50 && q.rsi2 < 70) {
    // Neutral — momentum without being overbought
    signals.push(`RSI2~ neutral(${q.rsi2.toFixed(0)})`);
  }

  // Strategy 4: Relative Strength Rotation — 6m momentum positive (vs bonds/gold)
  if (q.mom6m != null && q.mom6m > 2) {
    score++;
    signals.push(`RSR✓ (+${q.mom6m.toFixed(1)}% 6m)`);
  }

  // Strategy 5: Asset-Class Momentum Rotation — 6m rank signal
  // Bonus point if BOTH 6m and 12m positive (strong trending asset)
  if (q.mom6m != null && q.mom12m != null && q.mom6m > 0 && q.mom12m > 0) {
    score++;
    signals.push(`ACMR✓ (dual positive)`);
  }

  return { score, signals };
}

// ============================================================
// ALLOCATION ADVISOR
// ============================================================

interface AllocationSlot {
  etf: QuoteData;
  score: number;
  signals: string[];
  allocationPct: number;
  suggestedAction: string;
}

function buildAllocationPlan(
  globalQuotes: QuoteData[],
  sgQuotes: QuoteData[]
): { global: AllocationSlot[]; sg: AllocationSlot[] } {
  // Score and rank global ETFs
  const scoredGlobal = globalQuotes
    .map((q) => {
      const { score, signals } = scoreETF(q);
      return { etf: q, score, signals };
    })
    .sort((a, b) => b.score - a.score || a.etf.ter - b.etf.ter); // rank by score, then TER

  // Score and rank SG ETFs
  const scoredSg = sgQuotes
    .map((q) => {
      const { score, signals } = scoreETF(q);
      return { etf: q, score, signals };
    })
    .sort((a, b) => b.score - a.score || a.etf.ter - b.etf.ter);

  // Build global 85% — top 3 by score
  const globalSlots: AllocationSlot[] = [];
  const globalCandidates = scoredGlobal.slice(0, 3);
  const globalWeights = [50, 20, 15]; // 50+20+15 = 85

  globalCandidates.forEach((c, i) => {
    const pct = globalWeights[i] ?? 5;
    globalSlots.push({
      ...c,
      allocationPct: pct,
      suggestedAction: c.score >= 3 ? "BUY / HOLD" : c.score >= 2 ? "HOLD" : "REDUCE / SKIP",
    });
  });

  // Build SG 15% — split among top-scoring SG ETFs
  const sgSlots: AllocationSlot[] = [];
  const sgCandidates = scoredSg.slice(0, 2);
  const sgWeights = [10, 5];

  sgCandidates.forEach((c, i) => {
    const pct = sgWeights[i] ?? 5;
    sgSlots.push({
      ...c,
      allocationPct: pct,
      suggestedAction: c.score >= 3 ? "BUY / HOLD" : c.score >= 2 ? "HOLD" : "REDUCE / SKIP",
    });
  });

  return { global: globalSlots, sg: sgSlots };
}

// ============================================================
// FORMAT HELPERS
// ============================================================

function fmt(n: number | null, decimals = 2, prefix = ""): string {
  if (n == null) return "N/A";
  const sign = n >= 0 ? "+" : "";
  return `${prefix}${sign}${n.toFixed(decimals)}`;
}

function fmtPrice(n: number | null): string {
  if (n == null) return "N/A";
  return `$${n.toFixed(2)}`;
}

function signal(score: number): string {
  if (score >= 4) return "STRONG";
  if (score >= 3) return "BUY";
  if (score >= 2) return "HOLD";
  return "WEAK";
}

// ============================================================
// BUILD REPORT
// ============================================================

async function buildReport(): Promise<string> {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-SG", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "Asia/Singapore",
  });

  console.log("Fetching Global UCITS ETF data...");
  const globalQuotes = await fetchAllQuotes(GLOBAL_UCITS_ETFS);

  console.log("Fetching SG ETF data...");
  const sgQuotes = await fetchAllQuotes(SG_ETFS);

  const { global: globalPlan, sg: sgPlan } = buildAllocationPlan(globalQuotes, sgQuotes);

  const lines: string[] = [];

  // Header
  lines.push(`📊 Weekly ETF Review — ${dateStr}`);
  lines.push(`Strategy: 85% Global UCITS | 15% Singapore`);
  lines.push(`Scored via 5 High-Expectancy Strategies`);
  lines.push("");

  // ---- GLOBAL 85% ----
  lines.push(`🌍 GLOBAL ALLOCATION (85%)`);
  lines.push(`Priority: UCITS, lowest TER, momentum-positive`);
  lines.push("");

  for (const slot of globalPlan) {
    const q = slot.etf;
    const tvUrl = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(q.ticker)}`;
    lines.push(`[${slot.allocationPct}%] ${q.ticker} — ${q.name} (TER ${q.ter}%)`);
    lines.push(`  ${q.description}`);
    lines.push(`  Price: ${fmtPrice(q.price)} | Wk: ${fmt(q.changePercent)}%`);
    lines.push(`  Momentum: 6m ${fmt(q.mom6m)}% | 12m ${fmt(q.mom12m)}%`);
    if (q.ma200 != null && q.price != null) {
      const above = ((q.price / q.ma200 - 1) * 100).toFixed(1);
      lines.push(`  vs 200DMA: ${above}% | RSI(2): ${q.rsi2?.toFixed(0) ?? "N/A"}`);
    }
    lines.push(`  Signal: ${signal(slot.score)}/5 | ${slot.suggestedAction}`);
    lines.push(`  Signals: ${slot.signals.join(" | ") || "none"}`);
    lines.push(`  Chart: ${tvUrl}`);
    lines.push("");
  }

  // Show remaining global ETFs (screened out) briefly
  const allScored = globalQuotes
    .map((q) => ({ ...q, ...scoreETF(q) }))
    .sort((a, b) => b.score - a.score || a.ter - b.ter);

  const others = allScored.filter((q) => !globalPlan.some((p) => p.etf.ticker === q.ticker));
  if (others.length > 0) {
    lines.push(`  Other UCITS tracked (screened out this week):`);
    for (const o of others) {
      lines.push(`  • ${o.ticker} (TER ${o.ter}%) — score ${o.score}/5 | ${fmt(o.mom6m)}% 6m`);
    }
    lines.push("");
  }

  // ---- SG 15% ----
  lines.push(`🇸🇬 SINGAPORE ALLOCATION (15%)`);
  lines.push("");

  for (const slot of sgPlan) {
    const q = slot.etf;
    const tvUrl = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(q.ticker)}`;
    lines.push(`[${slot.allocationPct}%] ${q.ticker} — ${q.name} (TER ${q.ter}%)`);
    lines.push(`  ${q.description}`);
    lines.push(`  Price: ${fmtPrice(q.price)} | Wk: ${fmt(q.changePercent)}%`);
    lines.push(`  Momentum: 6m ${fmt(q.mom6m)}% | 12m ${fmt(q.mom12m)}%`);
    lines.push(`  Signal: ${signal(slot.score)}/5 | ${slot.suggestedAction}`);
    lines.push(`  Chart: ${tvUrl}`);
    lines.push("");
  }

  const sgOthers = sgQuotes.filter((q) => !sgPlan.some((p) => p.etf.ticker === q.ticker));
  if (sgOthers.length > 0) {
    for (const o of sgOthers) {
      const { score } = scoreETF(o);
      lines.push(`  • ${o.ticker} — score ${score}/5 | ${fmt(o.mom6m)}% 6m`);
    }
    lines.push("");
  }

  // ---- PORTFOLIO SUMMARY ----
  lines.push(`📋 THIS WEEK'S SUGGESTED PORTFOLIO`);
  const allSlots = [...globalPlan, ...sgPlan];
  for (const slot of allSlots) {
    lines.push(`  ${slot.allocationPct}% ${slot.etf.ticker} (${slot.suggestedAction})`);
  }
  const totalPct = allSlots.reduce((s, p) => s + p.allocationPct, 0);
  lines.push(`  Total allocated: ${totalPct}%`);
  lines.push("");

  // ---- STRATEGY KEY ----
  lines.push(`📌 SIGNAL KEY`);
  lines.push(`  GEM = Global Equity Dual Momentum (12m positive)`);
  lines.push(`  SMA200 = Price above 200-day moving average`);
  lines.push(`  RSI2 = Mean reversion buy signal (oversold <15 + uptrend)`);
  lines.push(`  RSR = Relative Strength Rotation (6m momentum vs peers)`);
  lines.push(`  ACMR = Asset-Class Momentum (both 6m & 12m positive)`);
  lines.push("");
  lines.push(`⚡ S$15k quarterly DCA via IBKR LSE. Rebalance if >5% drift.`);
  lines.push(`💡 UCITS benefits: 15% WHT vs 30% for US ETFs + no US estate tax.`);

  return lines.join("\n");
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("Running Weekly UCITS ETF Analysis...");

  if (!validateGroup("GENERAL")) {
    console.error("Cannot run — GENERAL group not configured in .env");
    console.error("Set GROUP_GENERAL_CHAT_ID in your .env file");
    process.exit(1);
  }

  const report = await buildReport();
  await sendAndRecord(GROUPS.GENERAL.chatId, report, { routineName: 'weekly-etf', agentId: 'general-assistant' });
  console.log("Weekly UCITS ETF analysis sent to General group");
}

main().catch((error) => {
  console.error("Error running weekly ETF analysis:", error);
  process.exit(1);
});
