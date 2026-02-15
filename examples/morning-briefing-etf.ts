/**
 * Morning Briefing with ETF Stock Analysis
 *
 * Sends a daily summary via Telegram with focus on US market ETF stocks
 * for 1-2 year growth potential. Saves analysis as Obsidian note.
 *
 * Schedule this with:
 * - macOS: launchd (see daemon/morning-briefing.plist)
 * - Linux: cron or systemd timer
 * - Windows: Task Scheduler
 *
 * Run manually: bun run examples/morning-briefing-etf.ts
 */

import * as fs from "fs";
import * as path from "path";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const OBSIDIAN_VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || "";

// ============================================================
// TELEGRAM HELPER
// ============================================================

async function sendTelegram(message: string): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: message,
          parse_mode: "Markdown",
        }),
      }
    );

    return response.ok;
  } catch (error) {
    console.error("Telegram error:", error);
    return false;
  }
}

// ============================================================
// ETF STOCK ANALYSIS
// ============================================================

interface ETFAnalysis {
  ticker: string;
  name: string;
  currentPrice: string;
  growthPotential: string;
  risk: string;
  sector: string;
  recommendation: string;
}

async function analyzeGrowthETFs(): Promise<ETFAnalysis[]> {
  // Focus on 1-2 year growth ETFs in US market
  // These are example placeholders - in production, fetch from:
  // - Yahoo Finance API
  // - Alpha Vantage
  // - Financial Modeling Prep
  // - Your broker's API

  const growthETFs: ETFAnalysis[] = [
    {
      ticker: "QQQ",
      name: "Invesco QQQ (Nasdaq-100)",
      currentPrice: "$450",
      growthPotential: "Moderate-High",
      risk: "Medium",
      sector: "Technology",
      recommendation: "Hold - Strong tech exposure, volatile but solid long-term"
    },
    {
      ticker: "VUG",
      name: "Vanguard Growth ETF",
      currentPrice: "$320",
      growthPotential: "Moderate",
      risk: "Medium",
      sector: "Growth Stocks",
      recommendation: "Buy - Diversified growth, lower fees"
    },
    {
      ticker: "ARKK",
      name: "ARK Innovation ETF",
      currentPrice: "$55",
      growthPotential: "High",
      risk: "High",
      sector: "Disruptive Innovation",
      recommendation: "Speculative - High risk, high reward potential"
    },
    {
      ticker: "SCHG",
      name: "Schwab US Large-Cap Growth",
      currentPrice: "$85",
      growthPotential: "Moderate",
      risk: "Low-Medium",
      sector: "Large Cap Growth",
      recommendation: "Buy - Conservative growth play, low expense ratio"
    },
    {
      ticker: "IWF",
      name: "iShares Russell 1000 Growth",
      currentPrice: "$330",
      growthPotential: "Moderate",
      risk: "Medium",
      sector: "Growth Stocks",
      recommendation: "Hold - Solid growth exposure, slightly higher fees"
    }
  ];

  return growthETFs;
}

async function getMarketSummary(): Promise<string> {
  // Placeholder - integrate with financial API
  return "S&P 500: +0.5% | Nasdaq: +0.8% | VIX: 14.2 (Low volatility)";
}

// ============================================================
// OBSIDIAN NOTE BUILDER
// ============================================================

function buildObsidianNote(etfs: ETFAnalysis[], marketSummary: string): string {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const dayName = now.toLocaleDateString("en-US", { weekday: "long" });

  let note = `# ETF Growth Stock Analysis - ${dayName}, ${dateStr}\n\n`;
  note += `## Market Summary\n${marketSummary}\n\n`;
  note += `## Focus: 1-2 Year Growth ETFs (US Market)\n\n`;

  etfs.forEach((etf, index) => {
    note += `### ${index + 1}. ${etf.ticker} - ${etf.name}\n`;
    note += `- **Current Price**: ${etf.currentPrice}\n`;
    note += `- **Growth Potential**: ${etf.growthPotential}\n`;
    note += `- **Risk Level**: ${etf.risk}\n`;
    note += `- **Sector**: ${etf.sector}\n`;
    note += `- **Recommendation**: ${etf.recommendation}\n\n`;
  });

  note += `## Action Items\n`;
  note += `- [ ] Review holdings in current portfolio\n`;
  note += `- [ ] Check rebalancing needs\n`;
  note += `- [ ] Monitor top performers for entry points\n\n`;

  note += `---\n`;
  note += `*Generated: ${now.toLocaleString("en-SG", { timeZone: "Asia/Singapore" })}*\n`;
  note += `*Tags: #investing #etf #growth-stocks #us-market*\n`;

  return note;
}

function saveToObsidian(content: string): boolean {
  if (!OBSIDIAN_VAULT_PATH) {
    console.error("OBSIDIAN_VAULT_PATH not set in .env");
    return false;
  }

  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const fileName = `ETF-Analysis-${dateStr}.md`;
  const filePath = path.join(OBSIDIAN_VAULT_PATH, fileName);

  try {
    fs.writeFileSync(filePath, content, "utf-8");
    console.log(`Saved to Obsidian: ${filePath}`);
    return true;
  } catch (error) {
    console.error("Failed to save to Obsidian:", error);
    return false;
  }
}

// ============================================================
// TELEGRAM BRIEFING BUILDER
// ============================================================

function buildTelegramBriefing(etfs: ETFAnalysis[], marketSummary: string): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  let message = `📊 **ETF Growth Stock Briefing**\n${dateStr}\n\n`;
  message += `📈 **Market Summary**\n${marketSummary}\n\n`;
  message += `🎯 **Top 1-2 Year Growth ETFs (US Market)**\n\n`;

  etfs.forEach((etf, index) => {
    message += `**${index + 1}. ${etf.ticker}** (${etf.name})\n`;
    message += `💰 ${etf.currentPrice} | 📊 ${etf.growthPotential} growth | ⚠️ ${etf.risk} risk\n`;
    message += `💡 ${etf.recommendation}\n\n`;
  });

  message += `---\n`;
  message += `📝 *Full analysis saved to Obsidian*\n`;
  message += `_Reply for detailed analysis or say "update portfolio"_`;

  return message;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("Building ETF morning briefing...");

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID");
    process.exit(1);
  }

  // Fetch data
  const [etfs, marketSummary] = await Promise.all([
    analyzeGrowthETFs(),
    getMarketSummary(),
  ]);

  // Save to Obsidian
  const obsidianNote = buildObsidianNote(etfs, marketSummary);
  const savedToObsidian = saveToObsidian(obsidianNote);

  // Build and send Telegram message
  const briefing = buildTelegramBriefing(etfs, marketSummary);
  console.log("Sending briefing...");
  const success = await sendTelegram(briefing);

  if (success) {
    console.log("Briefing sent successfully!");
    if (savedToObsidian) {
      console.log("Analysis saved to Obsidian");
    }
  } else {
    console.error("Failed to send briefing");
    process.exit(1);
  }
}

main();

// ============================================================
// SETUP INSTRUCTIONS
// ============================================================
/*

1. Add to .env:
   OBSIDIAN_VAULT_PATH=/path/to/your/obsidian/vault

2. For real market data, integrate one of these APIs:
   - Yahoo Finance: npm install yahoo-finance2
   - Alpha Vantage: https://www.alphavantage.co/
   - Financial Modeling Prep: https://financialmodelingprep.com/
   - IEX Cloud: https://iexcloud.io/

3. Schedule with launchd (macOS):
   Save as ~/Library/LaunchAgents/com.claude.morning-briefing-etf.plist

4. Example with real API (Yahoo Finance):

   import yahooFinance from 'yahoo-finance2';

   async function analyzeGrowthETFs(): Promise<ETFAnalysis[]> {
     const tickers = ['QQQ', 'VUG', 'ARKK', 'SCHG', 'IWF'];
     const analyses: ETFAnalysis[] = [];

     for (const ticker of tickers) {
       const quote = await yahooFinance.quote(ticker);
       // Process quote data and build analysis
       analyses.push({
         ticker,
         name: quote.shortName || ticker,
         currentPrice: `$${quote.regularMarketPrice?.toFixed(2)}`,
         // Add your analysis logic here
       });
     }

     return analyses;
   }

*/
