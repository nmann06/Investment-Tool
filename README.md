# Lettuce

An independent, browser-based fundamentals-versus-price research tool in the spirit of FAST Graphs. It charts a company's share price against its earnings, shades an earnings-justified value (15× EPS, or the company's own normal P/E), shows dividends paid out of those earnings, projects a five-year scenario, and tracks manually entered holdings.

Live at [app.nathanielmann.ca](https://app.nathanielmann.ca/app) (password protected). It is linked from Nathaniel Mann's homepage, [nathanielmann.ca](https://nathanielmann.ca), which lives in its own repository, [nmann06/homepage](https://github.com/nmann06/homepage).

## Setup

Requires Node.js 20 or newer. There are no npm dependencies, and no API keys are needed. Optionally copy `.env.local.example` to `.env.local` to set a password or SEC user agent (see [Real market data](#real-market-data)). `.env.local` is git-ignored and must never be committed.

## Run

On Windows, double-click `start.cmd`. It uses an available Node.js runtime to start the local server. If Node.js is on your PATH, you can also run:

```bash
npm start
```

Open `http://127.0.0.1:4173/app` while the server is running. Link straight to a company with `http://127.0.0.1:4173/app?ticker=AAPL`.

## Build and test

There is no build step. The browser loads `app.js`, `math.js` and the HTML/CSS as they are. To run the tests, double-click `test.cmd` or run `npm test`. Render runs the same tests on every deploy.

## Features

- FAST Graphs-style chart: month-end price, an orange earnings area (trailing EPS × 15 or × normal P/E), a green dividend area, a normal-P/E line and an optional dashed five-year scenario.
- 3, 5, 10-year and maximum chart windows.
- Current P/E, normal (median) P/E, fair value, margin of safety, EPS growth, dividend yield, payout ratio and annualized return over the window.
- Year-by-year table of diluted EPS, EPS change, dividends, payout ratio, price range and average P/E.
- Editable five-year scenario (EPS growth and exit P/E) with implied price and total return.
- Real U.S. companies loaded on demand, plus CSV import.
- Prices for the open ticker and every holding refresh every minute while the tab is visible.
- Holdings saved in the browser's local storage. Loaded tickers are cached in the browser for a week.

**Load ticker** reads the SEC filings and the full price history together. If Cboe has no prices for a ticker, the SEC data still loads and a **Load prices** button lets you retry. Links open a company with prices (`/app?ticker=AAPL`) or with filings only (`/app?ticker=AAPL&depth=sec`).

## Real market data

Lettuce combines two sources on the server:

| Data | Source | Notes |
| --- | --- | --- |
| Daily closing prices (split-adjusted) and the latest quote | [Cboe](https://www.cboe.com) delayed-quote data (`cdn.cboe.com/api/global/delayed_quotes/…`) | No key, no quota. History from 2004 in one request; quotes are about 15 minutes delayed. Unofficial: it's the data behind Cboe's own site, so it may change without notice. |
| Diluted EPS, dividends, revenue, margins, cash flow, debt, cash, equity, share counts, company name and industry | [SEC EDGAR](https://www.sec.gov/search-filings/edgar-application-programming-interfaces) XBRL company facts | Free, no key. Covers U.S. companies that file 10-K/10-Q reports. |
| 10-year Treasury yield (risk-free rate) and S&P 500 month-end values (for beta only) | [FRED](https://fred.stlouisfed.org) CSV downloads (`DGS10`, `SP500`) | Free, no key. Refreshed daily. |

Following `free_stock_dashboard_data_sources.md`, the server stores **raw** statement values, and every ratio is calculated in `math.js`. Keyless sources are used wherever possible. Alpha Vantage, Finnhub and FMP are not used. SEC filings cover everything they would have supplied except analyst estimates, which have no free source. Peers are entered by hand, since automatic peer lists need a keyed API.

### Fundamentals page

- **Growth:** 5- and 10-year CAGR of revenue and diluted EPS; 5-year CAGR of FCF per share, dividends and diluted share count.
- **Profitability:** gross, operating and FCF margins; ROIC = operating income × (1 − effective tax rate) ÷ average (debt + equity − cash).
- **Balance sheet:** cash plus short-term investments, debt (borrowings plus commercial paper, excluding leases), net debt, and debt ÷ TTM FCF.
- **Valuation:**
  - market cap = price × cover-page shares outstanding (diluted shares for multi-class filers)
  - EV = market cap + debt − cash
  - trailing P/E, P/FCF, FCF yield, EV/EBIT and EV/EBITDA
- **Cost of capital:**
  - CAPM cost of equity = 10-year Treasury + Blume-adjusted beta × equity risk premium (5% default, editable). Beta uses 60 months against the S&P 500.
  - Pre-tax cost of debt = interest expense ÷ average debt. If interest isn't reported, it's the 10-year Treasury + 1.5%.
  - WACC, and ROIC − WACC.
- **DCF:** two-stage free cash flow per share. Five years at the chosen growth rate, five years fading to terminal growth, then a Gordon terminal value, discounted at WACC. All inputs are editable.
- **Financial history:** ten fiscal years of the raw and derived values.
- **Peers:** the same metrics for tickers you add.

Trailing-twelve-month flows are last fiscal year + this year-to-date − the same year-to-date a year earlier.

Setup:

1. Optionally copy `.env.local.example` to `.env.local` and set `SEC_USER_AGENT` to a name and contact email. The SEC asks automated clients to identify themselves this way.
2. Start the server, enter a ticker such as `MSFT`, and press **Load ticker**.

The server caches each company's filings and price history in memory for 24 hours. On top of that it fetches Cboe's quote at most once a minute per symbol, shared by every visitor, and rebuilds the latest month from it. Each visitor may load 60 uncached companies per hour. If Cboe or the SEC can't be reached, previously loaded companies are served from the last fetch with a notice. Render's free plan clears memory when the service spins down.

## Password

The tool (`/app`) and its API require the password in `APP_PASSWORD`. Only the sign-in page and `/health` are public, and `/` redirects to `/app`. Visitors sign in once, and a signed session cookie keeps them in for 30 days. Changing the password signs everyone out. Failed attempts are limited to 10 per IP per 15 minutes. Locally the tool stays open if `APP_PASSWORD` is unset. On Render it is always locked, and it stays locked until the password is set.

### How the earnings line is built

1. Take every per-share fact for `EarningsPerShareDiluted` (falling back to `EarningsPerShareBasicAndDiluted`, then `EarningsPerShareBasic`) and the dividends-per-share tags, from 10-K and 10-Q filings.
2. **Detect stock splits.** Companies restate earlier per-share figures after a split. When at least two periods are restated by the same clean ratio (2, 3, 4, 10, 20, 50…), that is treated as a split occurring by the first restating filing. Every figure filed before a split is divided by the split ratio, so everything is on today's share basis, matching the split-adjusted prices.
3. For each period, keep the most recently filed value. Derive the fourth quarter as the fiscal year minus the nine-month year-to-date figure.
4. Trailing-twelve-month EPS at each quarter end is the fiscal-year figure (at year end) or the sum of four contiguous quarters. Values are linearly interpolated between quarter ends, like a blended P/E, and held flat after the latest report.

Limitations: earnings are GAAP, so one-time items such as write-downs or investment gains show up as spikes. Foreign filers using IFRS (20-F) aren't supported. Companies with several share classes report EPS per class and may not match the traded ticker. Always verify results for split-heavy companies.

## Deploy on Render

The repo includes `render.yaml` for a Render **web service** named `lattice-investment-tool`. Every push to `main` redeploys it. The homepage is a separate Render service with its own repository, so changes there never redeploy the tool.

1. In Render, create a new **Blueprint** from the GitHub repository. It defines a free Node web service, runs the tests during build and checks `/health`.
2. When prompted, set a strong `APP_PASSWORD`. `FINANCIALDATA_API_KEY` is no longer used and can be left empty. Set `SEC_USER_AGENT` to something like `Lettuce research you@example.com`. These secrets live only in Render's environment settings, never in the repository.
3. The Blueprint adds `app.nathanielmann.ca` as a custom domain. Add the CNAME record Render shows at your DNS provider. Keep any unrelated records intact.

Render runs the server on its assigned `PORT` and host `0.0.0.0`. The free service may spin down after inactivity, which clears the in-memory cache.

## Import your own data

Select **Import CSV** and supply a ticker, company name and file. The header must include `date,price,eps`; `dividend` is optional and means trailing twelve-month dividends per share. Dates must be `YYYY-MM-DD`, prices positive, and there must be at least two rows with unique dates. See [`sample-data.csv`](sample-data.csv).

The EPS column means *trailing twelve-month diluted EPS* for the observation date. Price and EPS must be on the **same share basis** across splits. Imported data stays in the current browser and is not sent to a server.

## Calculation rules

For the selected window, each observation with positive EPS gives a P/E of `price / eps`. Ratios outside 2–100 are excluded, and the median of the rest is the normal P/E. Fair value equals trailing EPS times the normal P/E. The orange earnings area uses 15× EPS by default, a long-standing benchmark for a fairly valued business. Margin of safety is `1 - latest price / fair value`; a negative result means price is above that benchmark.

EPS CAGR uses the first and latest positive EPS in the window. Annual return in range is the price change plus dividends received (not reinvested), annualized. The scenario compounds the latest EPS at the entered growth rate for five years and applies the entered exit P/E (normal P/E by default). The "with dividends" figure adds dividends at the current payout ratio.

These calculations are a research aid, not a forecast or recommendation. A company's historical multiple can be a poor guide to its future multiple.

The branding, interface and valuation calculations here are original. No competitor data or code is used.
