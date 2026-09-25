# Lattice

An independent, browser-based fundamentals-versus-price research tool in the spirit of FAST Graphs. It charts a company's share price against its earnings, shades an earnings-justified value (15× EPS, or the company's own normal P/E), shows dividends paid out of those earnings, projects a five-year scenario, and tracks manually entered holdings.

## Run

On Windows, double-click `start.cmd`. It uses an available Node.js runtime to start the local server. If Node.js is unavailable, it opens `index.html` directly instead.

If Node.js is installed on your PATH, you can also run:

```bash
node server.js
```

Open `http://127.0.0.1:4173` while the server is running, then choose **Investment Tool**. Link straight to a company with `http://127.0.0.1:4173/app?ticker=AAPL`. To run the tests, double-click `test.cmd` or run `npm test`.

## Features

- FAST Graphs-style chart: month-end price, an orange earnings area (trailing EPS × 15 or × normal P/E), a green dividend area, a normal-P/E line and an optional dashed five-year scenario.
- 3, 5, 10-year and maximum chart windows.
- Current P/E, normal (median) P/E, fair value, margin of safety, EPS growth, dividend yield, payout ratio and annualized return over the window.
- Year-by-year table of diluted EPS, EPS change, dividends, payout ratio, price range and average P/E.
- Editable five-year scenario (EPS growth and exit P/E) with implied price and total return.
- Real U.S. companies loaded on demand, plus four **synthetic** demo companies and CSV import.
- Holdings saved in the browser's local storage. Loaded tickers are cached in the browser for a week.

## Real market data

Lattice combines two sources on the server:

| Data | Source | Notes |
| --- | --- | --- |
| Daily closing prices (split-adjusted) | [FinancialData.net](https://financialdata.net) free plan | Requires an API key. History starts in 2015. 300 requests per day. Each new ticker uses about 10. |
| Diluted EPS, dividends per share, company name and industry | [SEC EDGAR](https://www.sec.gov/search-filings/edgar-application-programming-interfaces) XBRL API | Free, no key. Covers U.S. companies that file 10-K/10-Q reports. |

Setup:

1. Get a FinancialData.net API key.
2. Copy `.env.local.example` to `.env.local` and set `FINANCIALDATA_API_KEY`. Optionally set `SEC_USER_AGENT` to a name and contact email. The SEC asks automated clients to identify themselves this way.
3. Restart the server, enter a ticker such as `MSFT`, and press **Load real ticker**.

Keys stay on the server and are never sent to the browser. Company results are cached in server memory for 24 hours.

The server budgets 280 FinancialData.net requests a day, leaving headroom under the free plan's 300. It also allows 6 lookups per visitor per hour. A new ticker costs about 10 requests. After that, the server keeps its daily price history in memory, so a refresh fetches only the newest page (1 request). If a split has restated the history, it refetches everything. When the budget runs out, previously loaded companies are served from the last fetch with a notice. Render's free plan clears memory when the service spins down, so the first load after that is a full fetch again.

## Password

The homepage is public. The investment tool (`/app`) and its API require the password in `APP_PASSWORD`. Visitors sign in once, and a signed session cookie keeps them in for 30 days. Changing the password signs everyone out. Failed attempts are limited to 10 per IP per 15 minutes. Locally the tool stays open if `APP_PASSWORD` is unset. On Render it is always locked, and it stays locked until the password is set.

### How the earnings line is built

1. Take every per-share fact for `EarningsPerShareDiluted` (falling back to `EarningsPerShareBasicAndDiluted`, then `EarningsPerShareBasic`) and the dividends-per-share tags, from 10-K and 10-Q filings.
2. **Detect stock splits.** Companies restate earlier per-share figures after a split. When at least two periods are restated by the same clean ratio (2, 3, 4, 10, 20, 50…), that is treated as a split occurring by the first restating filing. Every figure filed before a split is divided by the split ratio, so everything is on today's share basis, matching the split-adjusted prices.
3. For each period, keep the most recently filed value. Derive the fourth quarter as the fiscal year minus the nine-month year-to-date figure.
4. Trailing-twelve-month EPS at each quarter end is the fiscal-year figure (at year end) or the sum of four contiguous quarters. Values are linearly interpolated between quarter ends, like a blended P/E, and held flat after the latest report.

Limitations: earnings are GAAP, so one-time items such as write-downs or investment gains show up as spikes. Foreign filers using IFRS (20-F) aren't supported. Companies with several share classes report EPS per class and may not match the traded ticker. Always verify results for split-heavy companies.

## Deploy on Render

The repo includes `render.yaml` for a Render **web service**.

1. In Render, create a new **Blueprint** from the GitHub repository. It defines a free Node web service, runs the tests during build and checks `/health`.
2. When prompted, set `FINANCIALDATA_API_KEY` and a strong `APP_PASSWORD`. Set `SEC_USER_AGENT` to something like `Lattice research you@example.com`.
3. The Blueprint adds `nathanielmann.ca` as a custom domain. Once the service is live, inspect the existing DNS records before changing them. Render's dashboard shows the exact records to add. Keep any unrelated email records intact.

Render runs the server on its assigned `PORT` and host `0.0.0.0`. The free service may spin down after inactivity, which clears the in-memory cache.

## Import your own data

Select **Import CSV** and supply a ticker, company name and file. The header must include `date,price,eps`; `dividend` is optional and means trailing twelve-month dividends per share. Dates must be `YYYY-MM-DD`, prices positive, and there must be at least two rows with unique dates. See [`sample-data.csv`](sample-data.csv).

The EPS column means *trailing twelve-month diluted EPS* for the observation date. Price and EPS must be on the **same share basis** across splits. Imported data stays in the current browser and is not sent to a server.

## Calculation rules

For the selected window, each observation with positive EPS gives a P/E of `price / eps`. Ratios outside 2–100 are excluded, and the median of the rest is the normal P/E. Fair value equals trailing EPS times the normal P/E. The orange earnings area uses 15× EPS by default, a long-standing benchmark for a fairly valued business. Margin of safety is `1 - latest price / fair value`; a negative result means price is above that benchmark.

EPS CAGR uses the first and latest positive EPS in the window. Annual return in range is the price change plus dividends received (not reinvested), annualized. The scenario compounds the latest EPS at the entered growth rate for five years and applies the entered exit P/E (normal P/E by default). The "with dividends" figure adds dividends at the current payout ratio.

These calculations are a research aid, not a forecast or recommendation. A company's historical multiple can be a poor guide to its future multiple.

The branding, interface and valuation calculations here are original. No competitor data or code is used.
