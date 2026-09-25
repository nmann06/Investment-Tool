# Lattice

An independent, browser-based fundamentals-versus-price research prototype. It compares historical share price with an EPS-based valuation benchmark, lets you explore five-year assumptions, and tracks manually entered holdings.

## Run

No packages or API keys are required. On Windows, double-click `start.cmd`. It uses an available Node.js runtime to start the local server. If Node.js is unavailable, it opens `index.html` directly instead.

If Node.js is installed on your PATH, you can also run:

```bash
node server.js
```

Open `http://127.0.0.1:4173` while the server is running. You can always open `index.html` directly in a browser without Node.js. To run the calculation tests on this computer, double-click `test.cmd`; it uses Codex's bundled Node.js runtime when Node.js is not installed separately. The test window stays open so you can read the results.

## Current features

- Responsive research dashboard with 5, 10, 15 and 20-year chart windows.
- Median historical P/E, fair-value line, margin of safety, EPS CAGR and an editable five-year price scenario.
- CSV import for a company and manual portfolio holdings, saved to that browser's local storage.
- Four **synthetic** companies for exploring the interface. Their prices and earnings are generated examples, not securities or market data.
- Optional Alpha Vantage integration for real monthly prices and reported earnings, served through a local API.

## Connect real market data

1. Get your own Alpha Vantage API key from [Alpha Vantage](https://www.alphavantage.co/support/#api-key). Check that your plan permits the history and use you need.
2. Copy `.env.local.example` to `.env.local` in the project folder. Replace `your_key_here` with your key. Do not put the key in `app.js` or commit `.env.local` to Git.
3. Restart `start.cmd`, open `http://127.0.0.1:4173`, enter a ticker such as `MSFT`, and click **Load real ticker**.

The local server uses the key for Alpha Vantage's monthly adjusted price series, quarterly earnings, split history and company overview. The key is never sent to the browser. Results are cached in server memory for 12 hours to reduce API calls; restarting the server clears the cache. The provider may rate limit or restrict endpoints based on your plan. Real data is end-of-month, not a live quote.

The transformation uses each month's raw close and the latest four quarterly EPS reports published by that date. It adjusts historical prices and EPS for later stock splits to put them on a common share basis. Alpha Vantage does not clearly specify the split adjustment basis of its historical reported EPS in its public endpoint description; verify results for split-heavy companies before relying on valuations. The chart will show an error if prices, EPS or split history are incomplete. API data is currently kept in memory only; reloading the page requires another ticker load.

## Deploy on Render

The repo includes `render.yaml` for a Render **web service**. Render needs a GitHub repository containing these files. The local repository currently has no Git remote, so connect it to your GitHub repository and push the code before creating the Render service.

1. In Render, create a new **Blueprint** from the GitHub repository. The Blueprint defines a free Node web service, runs the tests during build, and checks `/health`.
2. When Render prompts for secrets, set `ALPHA_VANTAGE_API_KEY` to your provider key and choose a separate, strong `APP_PASSWORD`. Do not commit either value to Git.
3. After deployment, visit the Render URL. The browser login username is `lattice`; the password is your `APP_PASSWORD`.
4. The Blueprint adds `nathanielmann.ca` as a custom domain. Once the service is live, inspect the existing GoDaddy DNS records before changing them. For a root domain, Render currently documents an `A` record at `@` pointing to `216.24.57.1`; its dashboard will show the exact verification steps. Render also adds `www` as a redirect to the root domain. Keep any unrelated email records intact.

Render runs the server on its assigned `PORT` and host `0.0.0.0`. The site password is required when running on Render so the public API cannot be called anonymously. Render's free web service may spin down after inactivity; the in-memory provider cache resets when that happens. Portfolio holdings remain in each visitor's browser rather than on Render.

## Import your own data

Select **Import CSV** and supply a ticker, company name and file. The header must include `date,price,eps`; `dividend` is optional. Dates must be `YYYY-MM-DD`, prices positive, and there must be at least two rows with unique dates. See [`sample-data.csv`](sample-data.csv).

The EPS column means *trailing twelve-month diluted EPS* for the observation date. Price and EPS must be adjusted to the **same share basis** across splits. The importer does not fetch data, adjust splits, handle restatements or infer EPS from quarterly reports. Use a properly licensed source before relying on real-company figures. Imported data stays in the current browser and is not sent to a server.

## Calculation rules

For the selected lookback period, each observation with positive EPS gives a P/E of `price / eps`. Ratios outside 2–100 are excluded, and the median of the remaining ratios is the normal P/E. Historical and latest fair value equal positive trailing EPS times that normal P/E. Margin of safety is `1 - latest price / latest fair value`; a negative result means price exceeds that benchmark.

EPS CAGR uses the first positive EPS and latest positive EPS in the period and the elapsed calendar years between them. The scenario compounds the latest EPS at the entered annual growth rate for five years, applies the entered exit P/E (or normal P/E by default), then annualizes the implied *price-only* return.

These calculations are a research aid, not a forecast or recommendation. The result omits dividends, taxes, fees, changes in share count, and uncertainty in future earnings. A company's historical multiple can be a poor guide to its future multiple.

## Next development milestones

1. Select and license a financial-data provider. Add server-side ingestion and a database for split-adjusted prices, reported/normalized EPS, dividends, and estimates. Do not expose provider keys in browser code.
2. Record fiscal period, as-of date, revision history and adjustment basis so the chart cannot silently pair mismatched figures.
3. Add provider-backed ticker search and scheduled refresh, then validate a small company set before expanding to the S&P 500.
4. Add accounts, server-saved portfolios, screener and billing after the data and calculation pipeline is reliable.

The branding, interface and valuation calculations here are original. No competitor data or code is used.
