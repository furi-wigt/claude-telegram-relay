# ETF Growth Stock Analysis — Morning Briefing

Automated morning routine that analyzes US market ETF stocks with 1-2 year growth potential and saves analysis as Obsidian notes.

## Features

- 📊 **Daily ETF Analysis**: Focus on growth-oriented ETFs in US market
- 📝 **Obsidian Integration**: Automatically saves detailed analysis as markdown notes
- 💬 **Telegram Delivery**: Concise briefing delivered to your Telegram each morning
- 🎯 **Growth Focus**: Optimized for 1-2 year investment horizon

## Quick Start

### 1. Configure Obsidian Path

Add to your `.env`:

```bash
OBSIDIAN_VAULT_PATH=/path/to/your/obsidian/vault
```

Example:
```bash
OBSIDIAN_VAULT_PATH=/Users/furi/Documents/ObsidianVault
```

### 2. Test It Manually

```bash
bun run examples/morning-briefing-etf.ts
```

You should see:
- A Telegram message with the ETF briefing
- A new markdown file in your Obsidian vault: `ETF-Analysis-YYYY-MM-DD.md`

### 3. Schedule It

**macOS (launchd)**:
```bash
bun run setup:launchd -- --service etf-briefing
```

**Linux (cron)**:
```bash
# Add to crontab (runs at 9 AM daily)
crontab -e

# Add this line:
0 9 * * * cd /path/to/claude-telegram-relay && bun run examples/morning-briefing-etf.ts >> /tmp/etf-briefing.log 2>&1
```

**Windows (Task Scheduler)**:
Create a scheduled task that runs:
```
C:\path\to\bun.exe run examples/morning-briefing-etf.ts
```

## What You Get

### Telegram Briefing (Concise)

```
📊 ETF Growth Stock Briefing
Sunday, February 15, 2026

📈 Market Summary
S&P 500: +0.5% | Nasdaq: +0.8% | VIX: 14.2 (Low volatility)

🎯 Top 1-2 Year Growth ETFs (US Market)

1. QQQ (Invesco QQQ)
💰 $450 | 📊 Moderate-High growth | ⚠️ Medium risk
💡 Hold - Strong tech exposure, volatile but solid long-term

2. VUG (Vanguard Growth ETF)
💰 $320 | 📊 Moderate growth | ⚠️ Medium risk
💡 Buy - Diversified growth, lower fees

...
```

### Obsidian Note (Detailed)

Saved as `ETF-Analysis-2026-02-15.md`:

```markdown
# ETF Growth Stock Analysis - Sunday, 2026-02-15

## Market Summary
S&P 500: +0.5% | Nasdaq: +0.8% | VIX: 14.2 (Low volatility)

## Focus: 1-2 Year Growth ETFs (US Market)

### 1. QQQ - Invesco QQQ (Nasdaq-100)
- **Current Price**: $450
- **Growth Potential**: Moderate-High
- **Risk Level**: Medium
- **Sector**: Technology
- **Recommendation**: Hold - Strong tech exposure, volatile but solid long-term

...

## Action Items
- [ ] Review holdings in current portfolio
- [ ] Check rebalancing needs
- [ ] Monitor top performers for entry points

---
*Generated: 2/15/2026, 9:00:00 AM*
*Tags: #investing #etf #growth-stocks #us-market*
```

## Integrate Real Market Data

The current version uses placeholder data. To get real-time market data:

### Option A: Yahoo Finance (Free)

```bash
bun add yahoo-finance2
```

Update `analyzeGrowthETFs()` in `examples/morning-briefing-etf.ts`:

```typescript
import yahooFinance from 'yahoo-finance2';

async function analyzeGrowthETFs(): Promise<ETFAnalysis[]> {
  const tickers = ['QQQ', 'VUG', 'ARKK', 'SCHG', 'IWF'];
  const analyses: ETFAnalysis[] = [];

  for (const ticker of tickers) {
    const quote = await yahooFinance.quote(ticker);

    analyses.push({
      ticker,
      name: quote.shortName || ticker,
      currentPrice: `$${quote.regularMarketPrice?.toFixed(2)}`,
      growthPotential: calculateGrowth(quote),
      risk: calculateRisk(quote),
      sector: quote.sector || "Unknown",
      recommendation: generateRecommendation(quote),
    });
  }

  return analyses;
}

function calculateGrowth(quote: any): string {
  const yearChange = quote.fiftyTwoWeekHighChangePercent || 0;
  if (yearChange > 30) return "High";
  if (yearChange > 15) return "Moderate-High";
  if (yearChange > 5) return "Moderate";
  return "Low";
}

function calculateRisk(quote: any): string {
  const beta = quote.beta || 1;
  if (beta > 1.3) return "High";
  if (beta > 1) return "Medium";
  return "Low-Medium";
}

function generateRecommendation(quote: any): string {
  // Your custom logic based on technical indicators
  const pe = quote.trailingPE || 0;
  const momentum = quote.fiftyDayAverageChangePercent || 0;

  // Example logic
  if (momentum > 5 && pe < 30) return "Buy - Strong momentum, reasonable valuation";
  if (momentum < -5) return "Wait - Downward trend";
  return "Hold - Monitor for entry point";
}
```

### Option B: Alpha Vantage (Free tier available)

Sign up at https://www.alphavantage.co/

```bash
# Add to .env
ALPHA_VANTAGE_API_KEY=your_key_here
```

```typescript
async function analyzeGrowthETFs(): Promise<ETFAnalysis[]> {
  const API_KEY = process.env.ALPHA_VANTAGE_API_KEY;
  const tickers = ['QQQ', 'VUG', 'ARKK', 'SCHG', 'IWF'];

  const analyses = await Promise.all(
    tickers.map(async (ticker) => {
      const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${ticker}&apikey=${API_KEY}`;
      const response = await fetch(url);
      const data = await response.json();
      const quote = data['Global Quote'];

      return {
        ticker,
        name: ticker, // Or fetch from OVERVIEW endpoint
        currentPrice: `$${parseFloat(quote['05. price']).toFixed(2)}`,
        // Add your analysis logic
      };
    })
  );

  return analyses;
}
```

### Option C: Financial Modeling Prep (Free tier)

https://financialmodelingprep.com/

Similar to Alpha Vantage but with more fundamental data.

## Customize ETF List

Edit the `analyzeGrowthETFs()` function to focus on your preferred ETFs:

```typescript
const tickers = [
  'QQQ',   // Tech-heavy Nasdaq
  'VUG',   // Vanguard Growth
  'ARKK',  // Disruptive innovation (high risk)
  'SCHG',  // Large-cap growth
  'IWF',   // Russell 1000 Growth

  // Add your own:
  'VOO',   // S&P 500 (for comparison)
  'VOOG',  // S&P 500 Growth
  'IWO',   // Small-cap growth
  'SPYG',  // SPDR S&P 500 Growth
];
```

## Advanced: Add Technical Indicators

For more sophisticated analysis, integrate technical indicators:

```bash
bun add technicalindicators
```

```typescript
import { RSI, MACD, SMA } from 'technicalindicators';

async function analyzeWithIndicators(ticker: string) {
  // Fetch historical prices
  const historicalData = await fetchHistoricalData(ticker);

  // Calculate RSI (Relative Strength Index)
  const rsi = RSI.calculate({
    values: historicalData.closes,
    period: 14
  });

  // Calculate MACD
  const macd = MACD.calculate({
    values: historicalData.closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false
  });

  // Generate signals
  const latestRSI = rsi[rsi.length - 1];
  const latestMACD = macd[macd.length - 1];

  if (latestRSI < 30) return "Oversold - potential buy";
  if (latestRSI > 70) return "Overbought - consider taking profits";
  if (latestMACD.MACD > latestMACD.signal) return "Bullish momentum";

  return "Neutral - monitor closely";
}
```

## Obsidian Tips

### Use Templates

Create an Obsidian template in your vault:

`Templates/ETF-Analysis-Template.md`:

```markdown
---
tags: [investing, etf, growth-stocks, us-market]
date: {{date}}
type: analysis
---

# ETF Growth Stock Analysis - {{date}}

## Quick Summary
<!-- Auto-populated by morning briefing -->

## Personal Notes
<!-- Add your own thoughts here -->

## Decisions Made
<!-- Track your buy/sell decisions -->

## Performance Tracking
<!-- Link to previous analyses -->
```

### Link Between Notes

Your Obsidian vault will accumulate daily analyses. Create links:

```markdown
Previous: [[ETF-Analysis-2026-02-14]]
Next: [[ETF-Analysis-2026-02-16]]
```

### Use Dataview Plugin

If you have Dataview plugin installed, create a dashboard:

```markdown
# ETF Analysis Dashboard

```dataview
TABLE
  file.cdate as "Date",
  file.link as "Analysis"
FROM #etf
SORT file.cdate DESC
LIMIT 10
```

This shows your last 10 analyses.

## Troubleshooting

### Obsidian Note Not Saving

1. Check `OBSIDIAN_VAULT_PATH` in `.env`:
   ```bash
   echo $OBSIDIAN_VAULT_PATH
   ```

2. Ensure the path exists and is writable:
   ```bash
   ls -la "$OBSIDIAN_VAULT_PATH"
   ```

3. Test manually:
   ```bash
   bun run examples/morning-briefing-etf.ts
   ```

### Telegram Message Not Sent

1. Verify bot token and user ID in `.env`
2. Test with: `bun run test:telegram`

### API Rate Limits

Free financial APIs have rate limits:
- Yahoo Finance: Reasonable for personal use
- Alpha Vantage: 5 requests/minute, 500/day (free tier)
- Financial Modeling Prep: 250 requests/day (free tier)

Cache data if hitting limits.

## Next Steps

1. **Set up real market data** (Yahoo Finance is easiest)
2. **Customize ETF list** for your strategy
3. **Schedule the briefing** to run daily
4. **Add your own analysis logic** based on your investment criteria
5. **Connect to your brokerage** (if they have an API) to track actual holdings

---

Questions? Check the main README or open an issue.
