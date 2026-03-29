#!/usr/bin/env bun

/**
 * @routine etf-52week-screener
 * @description Daily ETF screener — 52W high breakout + VIX regime + volume + Triple RSI
 * @schedule 0 22 * * *
 * @target GENERAL group
 *
 * Screening logic:
 * - Threshold:          within 5% of 52-week high  (pctFromHigh >= -5%)
 * - Confirmed breakout: new 52W high + volume > 1.2× 3-month avg
 * - Unconfirmed:        new 52W high but low volume (shown in candidates)
 * - VIX regime:         Bull (<18) / Caution (18-25) / Bear (>25)
 * - Triple RSI:         RSI14 < 50 AND RSI7 < 40 AND RSI3 < 15 (weekly)
 *
 * Run manually: bun run routines/etf-52week-screener.ts
 */

import YahooFinance from "yahoo-finance2";
const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey", "ripHistorical"] });
import { sendAndRecord } from "../src/utils/routineMessage.ts";
import { sendToGroup } from "../src/utils/sendToGroup.ts";
import { GROUPS, validateGroup } from "../src/config/groups.ts";
import { USER_TIMEZONE } from "../src/config/userConfig.ts";

function resolveEtfScreenerGroupKey(): string | undefined {
  for (const key of [
    process.env.ETF_SCREENER_GROUP,
    "OPERATIONS",
    Object.keys(GROUPS).find((k) => (GROUPS[k]?.chatId ?? 0) !== 0),
  ]) {
    if (key && (GROUPS[key]?.chatId ?? 0) !== 0) return key;
  }
  return undefined;
}

const ETF_SCREENER_GROUP_KEY = resolveEtfScreenerGroupKey();

// ── ETF Universe (~55 tickers) ────────────────────────────────────────────────

export const ETF_UNIVERSE: Array<{ ticker: string; name: string }> = [
  // ── SGX ETFs (~12 tickers, .SI) ───────────────────────────────────────────
  { ticker: "ES3.SI",  name: "SPDR STI ETF" },
  { ticker: "G3B.SI",  name: "Nikko AM STI ETF" },
  { ticker: "CLR.SI",  name: "iShares MSCI AC Asia ex Japan" },
  { ticker: "MBH.SI",  name: "iShares Asia Pacific Dividend" },
  { ticker: "A35.SI",  name: "ABF Singapore Bond Index" },
  { ticker: "O9P.SI",  name: "SPDR Gold Shares" },
  { ticker: "GLD.SI",  name: "SPDR Gold MiniShares" },
  { ticker: "O87.SI",  name: "NikkoAM-StraitsTrading MSCI China" },
  { ticker: "QS0.SI",  name: "Xtrackers MSCI World Swap" },
  { ticker: "VG1.SI",  name: "CSOP FTSE China A50" },
  { ticker: "EWS.SI",  name: "iShares MSCI Singapore" },
  { ticker: "CFA.SI",  name: "Phillip SGD Money Market" },

  // ── iShares UCITS — Core Equity (LSE, .L) ────────────────────────────────
  { ticker: "IWDA.L",  name: "iShares Core MSCI World" },
  { ticker: "CSPX.L",  name: "iShares Core S&P 500" },
  { ticker: "SWDA.L",  name: "iShares MSCI World" },
  { ticker: "EIMI.L",  name: "iShares Core MSCI EM IMI" },
  { ticker: "SSAC.L",  name: "iShares Core MSCI All Country World" },
  { ticker: "ISAC.L",  name: "iShares MSCI ACWI" },
  { ticker: "LCWD.L",  name: "iShares MSCI World ESG Screened" },
  { ticker: "IMEU.L",  name: "iShares Core MSCI Europe" },
  { ticker: "IEUX.L",  name: "iShares Core MSCI Europe ex-UK" },
  { ticker: "IJPA.L",  name: "iShares Core MSCI Japan" },
  { ticker: "NDIA.L",  name: "iShares MSCI India" },

  // ── iShares UCITS — US Market ────────────────────────────────────────────
  { ticker: "IUSA.L",  name: "iShares Core S&P 500 (GBP)" },
  { ticker: "ISPY.L",  name: "iShares Core S&P 500 GBP Hedged" },
  { ticker: "CNDX.L",  name: "iShares NASDAQ-100" },
  { ticker: "IUIT.L",  name: "iShares S&P 500 IT Sector" },
  { ticker: "QDVE.L",  name: "iShares S&P 500 Information Technology" },

  // ── iShares UCITS — European Exchanges (Xetra, .DE) ─────────────────────
  { ticker: "EXS1.DE", name: "iShares Core DAX" },
  { ticker: "EXSA.DE", name: "iShares Core EURO STOXX 50" },
  { ticker: "IQQQ.DE", name: "iShares NASDAQ-100 (EUR)" },
  { ticker: "IQQH.DE", name: "iShares Global Clean Energy" },

  // ── iShares UCITS — Factors / Smart Beta ────────────────────────────────
  { ticker: "IWMO.L",  name: "iShares MSCI World Momentum Factor" },
  { ticker: "IWQU.L",  name: "iShares MSCI World Quality Factor" },
  { ticker: "IWFV.L",  name: "iShares MSCI World Value Factor" },
  { ticker: "WDSC.L",  name: "iShares MSCI World Small Cap" },
  { ticker: "MVEU.L",  name: "iShares MSCI Europe Min Vol" },
  { ticker: "IEFM.L",  name: "iShares MSCI EM Min Volatility" },

  // ── iShares UCITS — Bonds ────────────────────────────────────────────────
  { ticker: "AGGU.L",  name: "iShares Core Global Aggregate Bond" },
  { ticker: "IGLA.L",  name: "iShares Core Global Aggregate Bond USD Hdg" },
  { ticker: "IBTL.L",  name: "iShares Treasury Bond 20+yr" },
  { ticker: "IBTM.L",  name: "iShares Treasury Bond 7-10yr" },
  { ticker: "IBTS.L",  name: "iShares Short Duration Bond" },
  { ticker: "CORP.L",  name: "iShares Core EUR Corp Bond" },
  { ticker: "IBCX.L",  name: "iShares Core EUR Corp Bond (USD)" },
  { ticker: "SLXX.L",  name: "iShares Core GBP Corp Bond" },
  { ticker: "IGLT.L",  name: "iShares Core UK Gilts" },
  { ticker: "SEMB.L",  name: "iShares J.P. Morgan EM Bond" },
  { ticker: "IS04.L",  name: "iShares USD Corp Bond 0-3yr" },

  // ── iShares UCITS — Commodities / Alternatives ───────────────────────────
  { ticker: "IGLN.L",  name: "iShares Physical Gold" },
  { ticker: "SGLP.L",  name: "iShares Physical Silver" },
  { ticker: "PAGG.L",  name: "iShares Diversified Commodity Swap" },

  // ── iShares UCITS — Regional / Country ───────────────────────────────────
  { ticker: "IBZL.L",  name: "iShares MSCI Brazil" },
  { ticker: "IAPD.L",  name: "iShares Asia Pacific Dividend" },
  { ticker: "IJPN.L",  name: "iShares MSCI Japan" },
  { ticker: "H4ZN.L",  name: "iShares Core MSCI Pacific ex-Japan" },
  { ticker: "IUKD.L",  name: "iShares UK Dividend" },
  { ticker: "INRG.L",  name: "iShares Global Clean Energy (GBP)" },
];

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ETFResult {
  ticker: string;
  name: string;
  price: number;
  high52w: number;
  pctFromHigh: number;
  currency: string;
  displayPrice: string;
  isBreakout: boolean;
  volumeConfirmed: boolean;
  // Populated by enrichWithRsi() — undefined until then
  rsi14?: number;
  rsi7?: number;
  rsi3?: number;
  tripleRsiOversold?: boolean;
}

export interface VixData {
  value: number;
  regime: "bull" | "caution" | "bear";
  label: string;
  emoji: string;
}

// ── Currency formatting ───────────────────────────────────────────────────────

export function formatPrice(price: number, currency: string): string {
  // .L tickers on Yahoo return prices in GBp (pence) — convert to pounds
  if (currency === "GBp") {
    return `£${(price / 100).toFixed(2)}`;
  }
  const symbols: Record<string, string> = {
    GBP: "£",
    USD: "$",
    SGD: "S$",
    EUR: "€",
  };
  const sym = symbols[currency] ?? `${currency} `;
  return `${sym}${price.toFixed(2)}`;
}

// ── VIX regime ────────────────────────────────────────────────────────────────

export async function fetchVix(): Promise<VixData | null> {
  try {
    const q = await yahooFinance.quote("^VIX", {}, { validateResult: false });
    if (!q) return null;
    const value = q.regularMarketPrice ?? 0;
    if (value === 0) return null;
    if (value < 18)  return { value, regime: "bull",    label: "Bull Mode",    emoji: "🟢" };
    if (value <= 25) return { value, regime: "caution", label: "Caution Mode", emoji: "⚠️" };
    return              { value, regime: "bear",    label: "Bear Mode",    emoji: "🔴" };
  } catch {
    return null;
  }
}

// ── Fetch ETF quotes ───────────────────────────────────────────────────────────

export async function fetchQuotes(): Promise<ETFResult[]> {
  const nameMap = new Map(ETF_UNIVERSE.map(e => [e.ticker, e.name]));
  const symbols = ETF_UNIVERSE.map(e => e.ticker);
  const results: ETFResult[] = [];

  // Fetch in batches of 10 to avoid rate limiting
  const BATCH = 10;
  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);
    const settled = await Promise.allSettled(
      batch.map(ticker =>
        yahooFinance.quote(ticker, {}, { validateResult: false })
      )
    );

    for (let j = 0; j < settled.length; j++) {
      const r = settled[j];
      const ticker = batch[j];

      if (r.status === "rejected") {
        console.warn(`Skip ${ticker}: ${r.reason}`);
        continue;
      }

      const q = r.value;
      if (!q) {
        console.warn(`Skip ${ticker}: empty response`);
        continue;
      }

      const price = q.regularMarketPrice ?? 0;
      const high52w = q.fiftyTwoWeekHigh ?? 0;
      const currency = q.currency ?? "USD";

      if (!price || !high52w) {
        console.warn(`Skip ${ticker}: missing price (${price}) or 52w high (${high52w})`);
        continue;
      }

      // Volume confirmation: today's volume > 1.2× 3-month avg (breakout filter)
      const volume = q.regularMarketVolume ?? 0;
      const avgVolume = (q as any).averageDailyVolume3Month ?? (q as any).averageVolume ?? 0;
      const volumeConfirmed = avgVolume > 0 && volume > avgVolume * 1.2;

      const pctFromHigh = ((price - high52w) / high52w) * 100;
      const isBreakout = price > high52w;

      results.push({
        ticker,
        name: nameMap.get(ticker) ?? ticker,
        price,
        high52w,
        pctFromHigh,
        currency,
        displayPrice: formatPrice(price, currency),
        isBreakout,
        volumeConfirmed,
      });
    }
  }

  return results;
}

// ── RSI calculation (Wilder's smoothed) ──────────────────────────────────────

export function calcRsi(closes: number[], period: number): number {
  if (closes.length < period + 1) return 50; // neutral fallback

  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }

  // Seed with simple average of first period
  let avgGain = gains.slice(0, period).reduce((s, v) => s + v, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((s, v) => s + v, 0) / period;

  // Wilder's smoothing for remaining periods
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 10) / 10;
}

// ── Fetch weekly closes for RSI ───────────────────────────────────────────────

export async function fetchWeeklyCloses(ticker: string): Promise<number[] | null> {
  try {
    const period2 = new Date();
    const period1 = new Date(period2.getTime() - 280 * 24 * 60 * 60 * 1000); // 40 weeks

    const chart = await yahooFinance.chart(
      ticker,
      { period1, period2, interval: "1wk" },
      { validateResult: false }
    );

    const closes = chart.quotes
      .map((q: any) => q.close)
      .filter((c: unknown): c is number => typeof c === "number" && c > 0);

    return closes.length >= 16 ? closes : null;
  } catch {
    return null;
  }
}

// ── Enrich passing ETFs with weekly RSI ──────────────────────────────────────

export async function enrichWithRsi(etfs: ETFResult[]): Promise<void> {
  // Batch RSI fetches in groups of 5 to avoid overwhelming Yahoo
  const BATCH = 5;
  for (let i = 0; i < etfs.length; i += BATCH) {
    const batch = etfs.slice(i, i + BATCH);
    const settled = await Promise.allSettled(
      batch.map(etf => fetchWeeklyCloses(etf.ticker))
    );

    for (let j = 0; j < settled.length; j++) {
      const r = settled[j];
      const etf = batch[j];

      if (r.status === "rejected" || !r.value) continue;

      const closes = r.value;
      etf.rsi14 = calcRsi(closes, 14);
      etf.rsi7  = calcRsi(closes, 7);
      etf.rsi3  = calcRsi(closes, 3);
      // Triple RSI: all three conditions must hold simultaneously
      etf.tripleRsiOversold =
        etf.rsi14 < 50 &&
        etf.rsi7  < 40 &&
        etf.rsi3  < 15;
    }
  }
}

// ── Screening ─────────────────────────────────────────────────────────────────

export const THRESHOLD_PCT = -5;

export function screenETFs(quotes: ETFResult[]): {
  breakouts: ETFResult[];
  candidates: ETFResult[];
} {
  // Keep only those within 5% of 52-week high (or above it = breakout)
  const passing = quotes
    .filter(q => q.pctFromHigh >= THRESHOLD_PCT)
    .sort((a, b) => b.pctFromHigh - a.pctFromHigh);

  return {
    // Volume-confirmed breakouts go to the top section
    breakouts: passing.filter(q => q.isBreakout && q.volumeConfirmed),
    // Everything else: near-high candidates + low-volume breakouts mixed in
    candidates: passing.filter(q => !q.isBreakout || !q.volumeConfirmed),
  };
}

// ── Format Telegram HTML ──────────────────────────────────────────────────────

export function formatMessage(
  breakouts: ETFResult[],
  candidates: ETFResult[],
  allPassing: ETFResult[],
  screened: number,
  vix: VixData | null
): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-SG", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: USER_TIMEZONE,
  });
  const timeStr = now.toLocaleTimeString("en-SG", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: USER_TIMEZONE,
  });

  const lines: string[] = [];

  lines.push(`📈 **ETF Breakout Watch**`);
  lines.push(`${dateStr} · ${timeStr} SGT`);
  lines.push("");

  // ── VIX regime banner ─────────────────────────────────────────────────────
  if (vix) {
    lines.push(`🌡️ Market Regime: VIX ${vix.value.toFixed(1)} — ${vix.emoji} ${vix.label}`);
    if (vix.regime === "bear") {
      lines.push(`_(VIX > 25: breakout win rate ~38% — trade with caution)_`);
    } else if (vix.regime === "caution") {
      lines.push(`_(VIX 18-25: win rate ~52% — reduce position size)_`);
    }
  } else {
    lines.push(`🌡️ Market Regime: VIX unavailable`);
  }
  lines.push("");

  // ── Confirmed breakouts ───────────────────────────────────────────────────
  if (breakouts.length > 0) {
    lines.push(`🚀 **NEW 52-Week High (Volume Confirmed):**`);
    for (const etf of breakouts) {
      const pct = `+${etf.pctFromHigh.toFixed(1)}%`;
      lines.push(`• ${etf.ticker} — ${etf.name} (${pct}) 🔥 ${etf.displayPrice}`);
    }
  } else {
    lines.push(`🚀 **NEW 52-Week High (Volume Confirmed):** None`);
  }
  lines.push("");

  // ── Candidates (near high + low-volume breakouts) ─────────────────────────
  if (candidates.length > 0) {
    lines.push(`📊 **Within 5% of High:**`);
    for (const etf of candidates) {
      const pct = etf.isBreakout ? `+${etf.pctFromHigh.toFixed(1)}% ⚡` : `${etf.pctFromHigh.toFixed(1)}%`;
      lines.push(`• ${etf.ticker} — ${etf.name}  ${pct}  ${etf.displayPrice}`);
    }
  } else {
    lines.push(`📉 No ETFs within 5% of high today`);
  }
  lines.push("");

  // ── Triple RSI oversold ───────────────────────────────────────────────────
  const oversold = allPassing.filter(e => e.tripleRsiOversold);
  if (oversold.length > 0) {
    lines.push(`⚡ **Triple RSI Oversold (bounce candidates):**`);
    lines.push(`_(RSI14<50, RSI7<40, RSI3<15 weekly — 91% historical win rate)_`);
    for (const etf of oversold) {
      lines.push(`• ${etf.ticker} — ${etf.name} (RSI3: ${etf.rsi3})`);
    }
    lines.push("");
  }

  const total = breakouts.length + candidates.length;
  lines.push(`🔍 Screened: ${screened} ETFs · ${total} near-high · ${oversold.length} oversold`);

  return lines.join("\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Running ETF 52-Week High Screener (with VIX + Volume + Triple RSI)...");

  if (!ETF_SCREENER_GROUP_KEY || !validateGroup(ETF_SCREENER_GROUP_KEY)) {
    console.error("Cannot run — no group configured");
    process.exit(0); // graceful skip — PM2 will retry on next cron cycle
  }

  // 1. VIX regime
  const vix = await fetchVix();
  if (vix) {
    console.log(`VIX: ${vix.value.toFixed(1)} — ${vix.label}`);
  } else {
    console.warn("VIX fetch failed, continuing without regime filter");
  }

  // 2. ETF quotes + volume
  const quotes = await fetchQuotes();
  console.log(`Fetched ${quotes.length}/${ETF_UNIVERSE.length} ETF quotes`);

  // 3. Screen for 5% threshold
  const { breakouts, candidates } = screenETFs(quotes);
  const allPassing = [...breakouts, ...candidates];
  console.log(`Breakouts (vol confirmed): ${breakouts.length}, Candidates: ${candidates.length}`);

  // 4. Enrich passing ETFs with weekly RSI
  console.log(`Fetching weekly RSI for ${allPassing.length} passing ETFs...`);
  await enrichWithRsi(allPassing);
  const tripleRsiCount = allPassing.filter(e => e.tripleRsiOversold).length;
  console.log(`Triple RSI oversold: ${tripleRsiCount}`);

  if (breakouts.length > 0) {
    console.log("Confirmed breakouts:", breakouts.map(e => `${e.ticker} +${e.pctFromHigh.toFixed(1)}%`).join(", "));
  }
  if (candidates.length > 0) {
    console.log("Near highs:", candidates.map(e => `${e.ticker} ${e.pctFromHigh.toFixed(1)}%`).join(", "));
  }

  const message = formatMessage(breakouts, candidates, allPassing, quotes.length, vix);

  await sendAndRecord(GROUPS[ETF_SCREENER_GROUP_KEY!].chatId, message, {
    routineName: "etf-52week-screener",
    agentId: "general-assistant",
    topicId: GROUPS[ETF_SCREENER_GROUP_KEY!].topicId,
  });

  console.log("ETF 52-week screener sent to General group");
}

// PM2's bun container uses require() internally, which sets import.meta.main = false.
// Fall back to pm_exec_path to detect when PM2 is the entry runner.
const _isEntry =
  import.meta.main ||
  process.env.pm_exec_path === import.meta.url?.replace("file://", "");

if (_isEntry) {
  main().catch(async (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("ETF screener failed:", err);
    try {
      if (ETF_SCREENER_GROUP_KEY) await sendToGroup(GROUPS[ETF_SCREENER_GROUP_KEY].chatId, `⚠️ etf-52week-screener failed:\n\n${msg}`);
    } catch { /* ignore secondary failure */ }
    process.exit(0); // exit 0 so PM2 does not immediately restart — next run at scheduled cron time
  });
}
