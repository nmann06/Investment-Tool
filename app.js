(() => {
  'use strict';
  const M = globalThis.ValuationMath;
  const $ = (id) => document.getElementById(id);
  const money = (value) => value == null || !Number.isFinite(value) ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value);
  const number = (value, digits = 1) => value == null || !Number.isFinite(value) ? '—' : value.toFixed(digits);
  const percent = (value, digits = 1) => { if (value == null || !Number.isFinite(value)) return '—'; const text = (value * 100).toFixed(digits); return Number(text) === 0 ? `${(0).toFixed(digits)}%` : `${value > 0 ? '+' : ''}${text}%`; };
  const plainPercent = (value, digits = 1) => value == null || !Number.isFinite(value) ? '—' : `${(value * 100).toFixed(digits)}%`;
  const axisMoney = (value) => `$${value >= 100 || value === 0 ? Math.round(value) : value >= 10 ? value.toFixed(0) : value.toFixed(1)}`;
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const readStore = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
  const saveStore = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } };
  const time = (date) => Date.parse(`${date}T00:00:00Z`);
  const YEAR_MS = 365.2425 * 86400000;
  const API_CACHE_MS = 7 * 86400000;
  const LIVE_MS = 60000;
  // Quote times are New York local time without an offset, so they are formatted as-is (read as UTC, printed as UTC).
  const quoteTime = (quote) => `${new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(`${quote.time}Z`))} ET`;

  // Data depth for real tickers: SEC filings only, plus the latest price, or plus full price history.
  const DEPTH = { sec: 0, price: 1, full: 2 };
  const depthOf = (company) => company?.source !== 'api' ? DEPTH.full : DEPTH[company.depth] ?? DEPTH.full;

  const companies = {};
  const imported = readStore('lattice.imported.v1', {});
  for (const [ticker, company] of Object.entries(imported)) {
    if (company && Array.isArray(company.rows)) companies[ticker] = company;
  }
  // Real tickers are kept for a week so holdings and the last research session survive a reload.
  const apiCache = readStore('lattice.api.v1', {});
  for (const [ticker, company] of Object.entries(apiCache)) {
    // Entries saved before statement data was added (no `ttm`) are refetched.
    if (company && Array.isArray(company.rows) && company.hasFundamentals && 'ttm' in company && Date.now() - Date.parse(company.fetchedAt) < API_CACHE_MS) companies[ticker] = company;
    else delete apiCache[ticker];
  }
  saveStore('lattice.api.v1', apiCache);
  let holdings = readStore('lattice.holdings.v1', []);
  if (!Array.isArray(holdings)) holdings = [];
  const storedTicker = readStore('lattice.selected.v1', null);
  let selectedTicker = companies[storedTicker] ? storedTicker : Object.keys(companies)[0] || null;
  let selectedYears = 10;
  let multipleMode = 'graham';
  let view = 'notes';
  let currentResult = null;
  let manualExitPe = false;

  function setText(id, value) { $(id).textContent = value; }
  function showView(next) {
    const views = ['notes', 'research', 'fundamentals', 'compare', 'portfolio', 'methodology'];
    view = views.includes(next) ? next : 'notes';
    for (const item of views) $(`${item}-view`).hidden = item !== view;
    document.querySelectorAll('.nav-link').forEach((link) => link.classList.toggle('active', link.dataset.view === view));
    setText('breadcrumb-current', view.toUpperCase());
    if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
    if (view === 'portfolio') renderPortfolio();
    if (view === 'research' && currentResult) renderChart(currentResult);
    if (view === 'fundamentals') renderFundamentals();
    if (view === 'compare') { renderCompare(); loadCompare(compareTickers); }
  }

  function renderChips(query = '') {
    const candidates = Object.values(companies).filter((company) => `${company.ticker} ${company.name}`.toLowerCase().includes(query.toLowerCase()));
    $('ticker-chips').innerHTML = candidates.length
      ? candidates.map((company) => `<button class="ticker-chip ${company.ticker === selectedTicker ? 'selected' : ''}" data-ticker="${escapeHtml(company.ticker)}">${escapeHtml(company.ticker)}</button>`).join('')
      : `<span class="company-meta">${query ? 'Press Enter or Load ticker to fetch this symbol.' : 'No tickers loaded yet.'}</span>`;
  }

  function selectTicker(ticker) {
    if (!companies[ticker]) return;
    selectedTicker = ticker;
    saveStore('lattice.selected.v1', ticker);
    manualExitPe = false;
    $('exit-pe-input').value = '';
    $('dcf-growth').value = '';
    $('dcf-discount').value = '';
    $('ticker-search').value = '';
    renderChips();
    renderResearch();
    if (view === 'fundamentals') renderFundamentals();
  }

  async function checkApiStatus() {
    try {
      const response = await fetch('/api/status');
      if (!response.ok) throw Error('Server unavailable');
      setText('sidebar-data-status', 'Market data connected');
      setText('sidebar-data-help', 'Prices from Cboe (about 15 minutes delayed, refreshed every minute); financials from SEC filings.');
    } catch {
      setText('sidebar-data-status', 'Server unavailable');
      setText('sidebar-data-help', 'Start the local server to load market data.');
    }
  }

  function depthMessage(message, kind = '') {
    for (const id of ['api-message', 'depth-message']) { $(id).textContent = message; $(id).className = `api-message ${kind}`; }
  }

  // Loads a ticker at the requested depth: 'full' adds Cboe prices to the SEC filings, 'sec' reads filings only.
  async function loadTicker(input, depth = 'full') {
    const ticker = String(input || '').trim().toUpperCase();
    if (!/^[A-Z0-9.\-]{1,12}$/.test(ticker)) { depthMessage('Enter a valid ticker symbol, such as MSFT.', 'error'); return; }
    if (ticker === 'APPL') { depthMessage('Apple trades as AAPL. Enter AAPL to load its data.', 'error'); return; }
    const existing = companies[ticker];
    if (existing && depthOf(existing) >= DEPTH[depth]) { selectTicker(ticker); return; }
    document.querySelectorAll('#load-ticker, .depth-button').forEach((button) => { button.disabled = true; });
    depthMessage(depth === 'sec' ? `Reading ${ticker}'s SEC filings…` : `Loading ${ticker}'s filings and prices…`);
    try {
      const response = await fetch(`/api/company?symbol=${encodeURIComponent(ticker)}&depth=${depth}`);
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(result.error || 'Could not load company data.');
      if (!Array.isArray(result.rows) || !Array.isArray(result.annual)) throw Error('The server returned incomplete data.');
      companies[ticker] = result;
      apiCache[ticker] = result;
      saveStore('lattice.api.v1', apiCache);
      selectTicker(ticker);
      const splits = result.splits?.length ? ` Adjusted for ${result.splits.length} stock split${result.splits.length > 1 ? 's' : ''}.` : '';
      const loaded = depthOf(result) === DEPTH.sec ? `${result.name}: SEC filings loaded.${result.priceError ? ` ${result.priceError}` : ''}`
        : `${result.name}: prices ${result.rows[0].date.slice(0, 4)}–${result.rows.at(-1).date.slice(0, 7)}${result.quote ? `, latest ${money(result.quote.price)} at ${quoteTime(result.quote)}` : ''}.${splits}`;
      depthMessage(result.stale ? `Showing saved ${result.name} data; the data sources could not be reached.` : loaded, result.stale || result.priceError ? '' : 'success');
      if (depthOf(result) === DEPTH.sec && view === 'research') showView('fundamentals');
      renderPortfolio();
      checkApiStatus();
    } catch (error) { depthMessage(error.message || 'Could not load market data.', 'error'); }
    finally { document.querySelectorAll('#load-ticker, .depth-button').forEach((button) => { button.disabled = false; }); }
  }

  // Offers the next data levels for the selected real ticker.
  function renderDepthActions(company) {
    const level = depthOf(company);
    const buttons = company?.source === 'api' && level < DEPTH.full ? '<button class="outline-button depth-button" data-depth="full" type="button">Load prices</button>' : '';
    document.querySelectorAll('.depth-actions').forEach((element) => { element.innerHTML = buttons; });
  }

  // What the company does, from "Item 1. Business" of its latest 10-K. Kept for 30 days, since it changes once a year.
  const PROFILE_MS = 30 * 86400000;
  const profiles = readStore('lattice.profiles.v1', {});
  for (const [ticker, profile] of Object.entries(profiles)) if (!profile?.fetchedAt || !Array.isArray(profile.summary) || Date.now() - Date.parse(profile.fetchedAt) > PROFILE_MS) delete profiles[ticker];
  const profileStatus = new Map();
  let renderedProfile = '';

  async function loadProfile(ticker) {
    profileStatus.set(ticker, 'loading');
    try {
      const response = await fetch(`/api/profile?symbol=${encodeURIComponent(ticker)}`);
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(result.error || 'Could not load the company description.');
      profiles[ticker] = result;
      // Each description can be ~20 KB, so only the 30 most recent are kept.
      const tickers = Object.keys(profiles);
      while (tickers.length > 30) delete profiles[tickers.shift()];
      saveStore('lattice.profiles.v1', profiles);
      profileStatus.delete(ticker);
    } catch (error) { profileStatus.set(ticker, error.message || 'Could not load the company description.'); }
    if (ticker === selectedTicker) renderProfile(companies[ticker]);
  }

  function renderProfile(company) {
    $('company-profile').hidden = company?.source !== 'api';
    if (company?.source !== 'api') { renderedProfile = ''; return; }
    const profile = profiles[company.ticker];
    const status = profileStatus.get(company.ticker);
    // Skip identical re-renders so the minute price refresh doesn't reset the reader's scroll position.
    const key = `${company.ticker}|${profile?.fetchedAt || status || 'none'}`;
    if (key === renderedProfile) return;
    renderedProfile = key;
    if (!profile) {
      $('profile-summary').innerHTML = `<p class="profile-status">${status && status !== 'loading' ? escapeHtml(status) : 'Reading the latest annual report…'}</p>`;
      $('profile-more').hidden = true;
      $('profile-more').open = false;
      $('profile-source').textContent = '';
      if (!status) loadProfile(company.ticker);
      return;
    }
    $('profile-summary').innerHTML = profile.summary.length ? profile.summary.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('') : '<p class="profile-status">The business section of this annual report could not be read automatically. The full report is linked below.</p>';
    $('profile-more').hidden = profile.business.length <= profile.summary.length;
    $('profile-more').open = false;
    // Short lines without closing punctuation are the filing's own subheadings.
    $('profile-business').innerHTML = profile.business.map((line) => line.length < 90 && !/[.:;,]$/.test(line) ? `<h4>${escapeHtml(line)}</h4>` : `<p>${escapeHtml(line)}</p>`).join('');
    const filing = profile.filing;
    $('profile-source').innerHTML = `From “Item 1. Business” in the ${escapeHtml(filing.form)}${filing.period ? ` for the year ending ${escapeHtml(filing.period)}` : ''}, filed ${escapeHtml(filing.filed)}. <a href="${escapeHtml(filing.url)}" target="_blank" rel="noopener">Read the full annual report ↗</a>`;
  }

  function areaMultiple(result) {
    return multipleMode === 'normal' && result?.normalPe != null ? result.normalPe : M.GRAHAM_PE;
  }

  function renderResearch() {
    const company = companies[selectedTicker];
    $('welcome-empty').hidden = Boolean(company);
    $('research-company').hidden = !company;
    renderProfile(company);
    if (!company) { $('research-content').hidden = true; $('chart-empty').hidden = true; currentResult = null; return; }
    renderDepthActions(company);
    setText('company-avatar', company.name.charAt(0).toUpperCase());
    setText('company-name', company.name);
    setText('company-ticker', company.ticker);
    const sourceLabel = company.source !== 'api' ? 'Imported data' : company.quote ? `${company.provider} · last trade ${quoteTime(company.quote)} (delayed)` : `${company.provider || 'Market data'} · updated ${String(company.fetchedAt || '').slice(0, 10)}`;
    setText('company-meta', `${company.sector || 'Unclassified'} · ${sourceLabel}`);
    setText('source-badge', company.source === 'api' ? (depthOf(company) === DEPTH.full ? 'REAL MARKET DATA' : 'SEC EDGAR DATA') : 'IMPORTED DATA');
    const needsChart = depthOf(company) < DEPTH.full;
    $('chart-empty').hidden = !needsChart;
    $('research-content').hidden = needsChart;
    if (needsChart) { currentResult = null; return; }
    const growthRate = Number($('growth-input').value) / 100;
    const typedExit = Number($('exit-pe-input').value);
    const exitPe = manualExitPe && typedExit > 0 ? typedExit : null;
    const result = M.calculate(company.rows, selectedYears, Number.isFinite(growthRate) ? growthRate : 0, exitPe);
    currentResult = result;
    const priceOnly = !company.rows.some((row) => row.eps != null);
    document.querySelectorAll('.fundamentals-legend').forEach((item) => { item.hidden = priceOnly; });
    $('forecast-panel').hidden = priceOnly;
    $('annual-panel').hidden = priceOnly;
    setText('chart-heading', priceOnly ? 'Historical share price' : 'Price vs. earnings');
    const range = result ? `${result.period[0].date.slice(0, 7)} to ${result.latest.date.slice(0, 7)}` : '';
    setText('chart-subtitle', priceOnly ? `Monthly closing observations · ${range}` : `Does the price follow the earnings? · ${range}`);
    $('growth-input').disabled = priceOnly;
    $('exit-pe-input').disabled = priceOnly;
    setText('chart-footnote', company.methodologyNote || 'Normal P/E is the median observed P/E within the selected period. Prices and EPS must use the same share basis.');
    setText('metric-price', money(result?.latest.price));
    setText('metric-price-date', !result ? 'No valid data' : company.quote?.date === result.latest.date ? `Delayed quote, ${quoteTime(company.quote)}` : `Month-end close, ${result.latest.date}`);
    setText('metric-current-pe', result?.currentPe == null ? '—' : `${number(result.currentPe)}×`);
    setText('metric-normal-pe', result?.normalPe == null ? '—' : `${number(result.normalPe)}×`);
    setText('metric-observations', priceOnly ? 'Requires EPS history' : result ? `Median of ${result.observationCount} months in range` : 'Historical median');
    setText('metric-safety', percent(result?.safety));
    $('metric-safety').className = `metric-value ${result?.safety == null ? '' : result.safety >= 0 ? 'positive' : 'negative'}`;
    setText('metric-safety-detail', priceOnly ? 'Requires EPS history' : result?.fairValue == null ? 'Unavailable with nonpositive EPS' : 'Versus fair value at normal P/E');
    setText('snapshot-fair', money(result?.fairValue));
    setText('snapshot-graham', money(result?.grahamValue));
    setText('snapshot-eps', result?.latest.eps == null ? '—' : `$${number(result.latest.eps, 2)}`);
    setText('snapshot-growth', percent(result?.epsGrowth));
    setText('snapshot-yield', result ? `${plainPercent(result.dividendYield, 2)} · ${result.payoutRatio == null ? '—' : plainPercent(result.payoutRatio, 0)}` : '—');
    setText('snapshot-return', result?.totalReturn == null ? '—' : `${percent(result.totalReturn)} (${number(result.elapsed, 1)}y)`);
    setText('forecast-return', percent(result?.projectedReturn));
    setText('forecast-price', result?.projectedPrice == null ? 'Projected price —' : `Projected price ${money(result.projectedPrice)} at ${number(result.projectionPe)}×`);
    setText('forecast-total', result?.projectedTotalReturn == null ? 'With dividends —' : `With dividends ${percent(result.projectedTotalReturn)} / year`);
    if (!manualExitPe) $('exit-pe-input').placeholder = result?.normalPe == null ? '—' : number(result.normalPe);
    const ratio = result?.fairValue ? result.latest.price / result.fairValue : 1;
    $('meter-marker').style.left = `${Math.min(98, Math.max(2, 50 + (ratio - 1) * 48))}%`;
    const insight = priceOnly ? 'Price history is available, but this data set has no EPS, so earnings-based valuation is unavailable.'
      : result?.fairValue == null ? 'Trailing earnings are negative or missing, so there is no earnings-based benchmark right now.'
      : `${result.safety >= 0 ? `The price is ${number(result.safety * 100)}% below` : `The price is ${number(-result.safety * 100)}% above`} where it has usually traded relative to earnings (${number(result.normalPe)}× over this window)${result.currentPe != null ? `, and ${result.currentPe <= M.GRAHAM_PE ? 'at or below' : 'above'} the 15× benchmark` : ''}.`;
    setText('insight-text', insight);
    const multiple = areaMultiple(result);
    setText('legend-earnings', multipleMode === 'normal' && result?.normalPe != null ? `Earnings × ${number(result.normalPe)} (normal)` : 'Earnings × 15');
    setText('legend-normal', multipleMode === 'normal' ? 'Earnings × 15' : `Normal P/E (${number(result?.normalPe)}×)`);
    document.querySelector('.scenario-legend').hidden = priceOnly || !$('scenario-toggle').checked;
    renderChart(result, multiple);
    renderAnnual(company, result);
  }

  function renderChart(result, multiple = areaMultiple(result)) {
    const svg = $('valuation-chart');
    const width = Math.max(300, svg.clientWidth || 900), height = Math.max(200, svg.clientHeight || 290);
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    if (!result || result.period.length < 2) { svg.innerHTML = `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" fill="#9bb8aa" font-size="13">At least two observations are needed to draw a chart.</text>`; return; }
    const rows = result.period;
    const priceOnly = rows.every((row) => row.eps == null);
    const lineMultiple = multipleMode === 'normal' ? M.GRAHAM_PE : result.normalPe;
    const scenario = !priceOnly && $('scenario-toggle').checked && result.latest.eps > 0;
    const left = 48, right = width - 16, top = 14, bottom = height - 26;
    const start = time(rows[0].date), end = time(result.latest.date);
    const finish = scenario ? end + 5 * YEAR_MS : end;
    const future = scenario ? [0, 1, 2, 3, 4, 5].map((year) => ({ t: end + year * YEAR_MS, eps: result.latest.eps * Math.pow(1 + result.growthRate, year) })) : [];
    const earningsValue = (eps) => eps > 0 ? eps * multiple : 0;
    const candidates = [
      ...rows.map((row) => row.price),
      ...(priceOnly ? [] : rows.map((row) => earningsValue(row.eps))),
      ...(priceOnly || lineMultiple == null ? [] : rows.map((row) => row.eps > 0 ? row.eps * lineMultiple : 0)),
      ...future.map((point) => point.eps * multiple),
      ...(scenario && result.projectedPrice != null ? [result.projectedPrice] : [])
    ];
    const maxValue = Math.max(...candidates) * 1.08 || 1;
    const x = (t) => left + (t - start) / (finish - start || 1) * (right - left);
    const y = (value) => bottom - Math.max(0, value) / maxValue * (bottom - top);
    const line = (points) => points.map((point, index) => point.v == null ? null : `${index === 0 || points[index - 1].v == null ? 'M' : 'L'}${x(point.t).toFixed(1)},${y(point.v).toFixed(1)}`).filter(Boolean).join(' ');
    const area = (points) => `M${x(points[0].t).toFixed(1)},${bottom} ${points.map((point) => `L${x(point.t).toFixed(1)},${y(point.v).toFixed(1)}`).join(' ')} L${x(points.at(-1).t).toFixed(1)},${bottom} Z`;
    const series = rows.map((row) => ({ t: time(row.date), row }));
    const steps = [0, .25, .5, .75, 1];
    const grid = steps.map((step) => { const yy = bottom - step * (bottom - top); return `<line x1="${left}" y1="${yy}" x2="${right}" y2="${yy}" stroke="#edf5f1"/><text x="${left - 8}" y="${yy + 3}" text-anchor="end" fill="#a0bbae" font-size="10">${axisMoney(maxValue * step)}</text>`; }).join('');
    const firstYear = new Date(start).getUTCFullYear() + 1, lastYear = new Date(finish).getUTCFullYear();
    const every = Math.max(1, Math.ceil((lastYear - firstYear + 1) / Math.max(4, Math.floor((right - left) / 58))));
    let ticks = '';
    for (let year = firstYear; year <= lastYear; year += every) {
      const xx = x(Date.UTC(year, 0, 1));
      if (xx < left || xx > right) continue;
      ticks += `<line x1="${xx}" y1="${bottom}" x2="${xx}" y2="${bottom + 4}" stroke="#d5e6de"/><text x="${xx}" y="${bottom + 17}" text-anchor="middle" fill="#a0bbae" font-size="10">${year}</text>`;
    }
    let layers = '';
    if (!priceOnly) {
      const earnings = series.map((point) => ({ t: point.t, v: earningsValue(point.row.eps) }));
      const dividends = series.map((point) => ({ t: point.t, v: Math.min(earningsValue(point.row.eps) || Infinity, (point.row.dividend || 0) * multiple) }));
      layers += `<path d="${area(earnings)}" fill="#f1ad6b" fill-opacity=".5"/><path d="${line(earnings)}" fill="none" stroke="#e08a3c" stroke-width="2"/>`;
      if (dividends.some((point) => point.v > 0)) layers += `<path d="${area(dividends)}" fill="#8fd0ae" fill-opacity=".85"/><path d="${line(dividends)}" fill="none" stroke="#45a676" stroke-width="1.5"/>`;
      if (lineMultiple != null) layers += `<path d="${line(series.map((point) => ({ t: point.t, v: point.row.eps > 0 ? point.row.eps * lineMultiple : null })))}" fill="none" stroke="#2f6fb3" stroke-width="2"/>`;
    }
    if (scenario) {
      const futureLine = future.map((point) => ({ t: point.t, v: point.eps * multiple }));
      layers += `<rect x="${x(end)}" y="${top}" width="${right - x(end)}" height="${bottom - top}" fill="#f6fbf9"/><text x="${x(end) + 8}" y="${top + 12}" fill="#9ab8aa" font-size="9" font-weight="700" letter-spacing=".8">SCENARIO · ${percent(result.growthRate, 1)} EPS / YR</text>`;
      layers += `<path d="${area(futureLine)}" fill="#f1ad6b" fill-opacity=".22"/><path d="${line(futureLine)}" fill="none" stroke="#e08a3c" stroke-width="2" stroke-dasharray="6 4"/>`;
      if (result.projectedPrice != null) {
        const px = x(future.at(-1).t), py = y(result.projectedPrice);
        layers += `<path d="M${x(end)},${y(result.latest.price)} L${px},${py}" stroke="#163b2a" stroke-width="1.6" stroke-dasharray="3 4" fill="none"/><circle cx="${px}" cy="${py}" r="4" fill="#163b2a"/><text x="${px - 8}" y="${py - 9}" text-anchor="end" fill="#163b2a" font-size="10" font-weight="700">${money(result.projectedPrice)}</text>`;
      }
    }
    const priceLine = line(series.map((point) => ({ t: point.t, v: point.row.price })));
    svg.innerHTML = `${grid}${layers}${ticks}<line x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}" stroke="#d5e6de"/><path d="${priceLine}" fill="none" stroke="#163b2a" stroke-width="2.2" stroke-linejoin="round"/><line id="hover-line" x1="0" x2="0" y1="${top}" y2="${bottom}" stroke="#99bdac" stroke-dasharray="3 3" visibility="hidden"/><circle id="hover-dot" r="4" fill="#163b2a" stroke="white" stroke-width="2" visibility="hidden"/>`;
    svg.onpointermove = (event) => {
      const bounds = svg.getBoundingClientRect();
      const px = (event.clientX - bounds.left) * width / bounds.width;
      const target = start + (px - left) / (right - left) * (finish - start);
      const tip = $('chart-tooltip');
      const hoverLine = $('hover-line'), dot = $('hover-dot');
      let xx, yy, html;
      if (scenario && target > end) {
        const point = future.reduce((best, item) => Math.abs(item.t - target) < Math.abs(best.t - target) ? item : best, future[0]);
        const years = Math.round((point.t - end) / YEAR_MS);
        xx = x(point.t); yy = y(point.eps * multiple);
        html = `<strong>Scenario · year ${years}</strong><br>Estimated EPS $${number(point.eps, 2)}<br>Earnings × ${number(multiple)} ${money(point.eps * multiple)}${years === 5 && result.projectedPrice != null ? `<br>Price at ${number(result.projectionPe)}× ${money(result.projectedPrice)}` : ''}`;
      } else {
        const point = series.reduce((best, item) => Math.abs(item.t - target) < Math.abs(best.t - target) ? item : best, series[0]);
        const row = point.row;
        xx = x(point.t); yy = y(row.price);
        html = `<strong>${row.date}</strong><br>Price ${money(row.price)}`;
        if (!priceOnly) html += `<br>TTM EPS ${row.eps == null ? '—' : `$${number(row.eps, 2)}`} · P/E ${row.eps > 0 ? `${number(row.price / row.eps)}×` : '—'}<br>Earnings × ${number(multiple)} ${money(earningsValue(row.eps))}${lineMultiple != null ? `<br>Earnings × ${number(lineMultiple)} ${row.eps > 0 ? money(row.eps * lineMultiple) : '—'}` : ''}<br>TTM dividend ${money(row.dividend || 0)}`;
      }
      hoverLine.setAttribute('x1', xx); hoverLine.setAttribute('x2', xx); hoverLine.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', xx); dot.setAttribute('cy', yy); dot.setAttribute('visibility', 'visible');
      tip.innerHTML = html;
      tip.hidden = false;
      const tipWidth = tip.offsetWidth || 160;
      const screenX = xx * bounds.width / width;
      tip.style.left = `${screenX + 14 + tipWidth > bounds.width ? screenX - tipWidth - 14 : screenX + 14}px`;
      tip.style.top = `${Math.max(4, Math.min(bounds.height - tip.offsetHeight - 4, yy * bounds.height / height - 40))}px`;
    };
    svg.onpointerleave = () => { $('chart-tooltip').hidden = true; $('hover-line').setAttribute('visibility', 'hidden'); $('hover-dot').setAttribute('visibility', 'hidden'); };
  }

  function renderAnnual(company, result) {
    const table = $('annual-table');
    if (!result) { table.innerHTML = ''; return; }
    const cutoff = result.period[0].date;
    const years = M.annualSummary(company.rows, company.annual).filter((item) => item.end >= cutoff);
    if (!years.length) { table.innerHTML = '<tbody><tr><td>No full fiscal years in this window.</td></tr></tbody>'; return; }
    setText('annual-subtitle', company.annual?.length ? 'Fiscal years from SEC filings, on today\'s share basis. Price high/low from month-end closes.' : 'Calendar years; EPS and dividends are the trailing values at year end.');
    const cell = (item, value) => `<td class="${item.partial ? 'partial' : ''}">${value}</td>`;
    const row = (label, render) => `<tr><td>${label}</td>${years.map((item) => cell(item, render(item))).join('')}</tr>`;
    table.innerHTML = `<thead><tr><th>${company.annual?.length ? 'FISCAL YEAR' : 'YEAR'}</th>${years.map((item) => `<th title="Period ending ${escapeHtml(item.end)}">${item.partial ? `${item.year}*` : item.year}</th>`).join('')}</tr></thead><tbody>${[
      row('Diluted EPS', (item) => item.eps == null ? '—' : `$${number(item.eps, 2)}`),
      row('EPS change', (item) => `<span class="${item.epsChange == null ? '' : item.epsChange >= 0 ? 'positive' : 'negative'}">${percent(item.epsChange, 0)}</span>`),
      row('Dividends / share', (item) => item.dividend == null ? '—' : `$${number(item.dividend, 2)}`),
      row('Payout ratio', (item) => item.dividend > 0 && item.eps > 0 ? plainPercent(item.dividend / item.eps, 0) : '—'),
      row('Price high', (item) => money(item.high)),
      row('Price low', (item) => money(item.low)),
      row('Average P/E', (item) => item.averagePe == null ? '—' : `${number(item.averagePe)}×`)
    ].join('')}</tbody>`;
    table.parentElement.scrollLeft = table.parentElement.scrollWidth;
  }

  const compactMoney = (value) => {
    if (value == null || !Number.isFinite(value)) return '—';
    const size = Math.abs(value);
    const [divisor, suffix] = size >= 1e12 ? [1e12, 'T'] : size >= 1e9 ? [1e9, 'B'] : size >= 1e6 ? [1e6, 'M'] : [1, ''];
    return `${value < 0 ? '−' : ''}$${(size / divisor).toFixed(size / divisor >= 100 || !suffix ? 0 : 1)}${suffix}`;
  };
  const compactNumber = (value) => value == null || !Number.isFinite(value) ? '—' : value >= 1e9 ? `${(value / 1e9).toFixed(2)}B` : `${(value / 1e6).toFixed(0)}M`;
  const multiple = (value) => value == null || !Number.isFinite(value) ? '—' : `${value.toFixed(1)}×`;
  const inputRate = (id) => { const text = $(id).value.trim(); const value = Number(text) / 100; return text === '' || !Number.isFinite(value) ? undefined : value; };
  const statRows = (items) => items.map(([label, value, hint]) => `<div><span>${label}${hint ? `<small>${hint}</small>` : ''}</span><strong>${value}</strong></div>`).join('');

  let market = null;
  let marketRequest = null;
  // Treasury yield (FRED) and SPY history for beta, loaded once per session.
  function ensureMarket() {
    if (market || marketRequest) return;
    marketRequest = fetch('/api/market').then((response) => response.ok ? response.json() : null).catch(() => null).then((data) => { market = data || { riskFree: null, benchmark: null }; if (view === 'fundamentals') renderFundamentals(); });
  }

  const hasStatements = (company) => Array.isArray(company?.annual) && company.annual.some((year) => Number.isFinite(year.revenue));
  const fundamentalsFor = (company, withInputs) => M.fundamentals(company, withInputs ? {
    benchmarkRows: market?.benchmark?.rows, riskFree: market?.riskFree?.rate, equityPremium: inputRate('erp-input'),
    dcfGrowth: inputRate('dcf-growth'), terminalGrowth: inputRate('dcf-terminal'), discount: inputRate('dcf-discount')
  } : {});

  function renderFundamentals() {
    const company = companies[selectedTicker];
    $('fund-company').hidden = !company;
    if (!company) {
      setText('fund-empty-title', 'Enter a U.S. ticker to begin');
      setText('fund-empty-text', 'Use the search box on the Research page to load a company\'s SEC filings and prices.');
      $('fund-empty').hidden = false; $('fund-content').hidden = true; return;
    }
    renderDepthActions(company);
    setText('fund-avatar', company.name.charAt(0).toUpperCase());
    setText('fund-name', company.name);
    setText('fund-ticker', company.ticker);
    const F = hasStatements(company) ? fundamentalsFor(company, true) : null;
    $('fund-empty').hidden = Boolean(F);
    $('fund-content').hidden = !F;
    if (!F) {
      setText('fund-empty-title', 'Fundamentals need SEC filings');
      setText('fund-empty-text', 'Imported companies only include price, EPS and dividends. Load a real ticker such as AAPL on the Research page.');
      setText('fund-meta', `${company.sector || 'Unclassified'} · no statement data`); return;
    }
    const hasPrice = Number.isFinite(F.price);
    const needsPrice = hasPrice ? '' : '<p class="valuation-note">Add the current price (1 request) to see market cap, multiples and FCF yield.</p>';
    ensureMarket();
    setText('fund-meta', `${company.sector || 'Unclassified'} · latest fiscal year ${F.latestYear.year} · trailing twelve months to ${F.ttmEnd}`);
    const g = F.growth, p = F.profitability, b = F.balance, v = F.valuation, c = F.capital;
    $('fund-growth').innerHTML = statRows([
      ['Revenue CAGR', `${percent(g.revenue5)} · ${percent(g.revenue10)}`, '5 yr · 10 yr'],
      ['Diluted EPS CAGR', `${percent(g.eps5)} · ${percent(g.eps10)}`, '5 yr · 10 yr'],
      ['FCF per share CAGR', percent(g.fcfPerShare5), '5 yr'],
      ['Dividend growth', percent(g.dividend5), '5 yr'],
      ['Share count change', percent(g.shares5), '5 yr, per year; negative = buybacks']
    ]);
    $('fund-profit').innerHTML = statRows([
      ['Gross margin', plainPercent(p.grossMargin), `FY${F.latestYear.year}`],
      ['Operating margin', plainPercent(p.operatingMargin), `TTM ${plainPercent(p.ttmOperatingMargin)}`],
      ['FCF margin', plainPercent(p.fcfMargin), `TTM ${plainPercent(p.ttmFcfMargin)}`],
      ['Return on invested capital', plainPercent(p.roic), `FY${F.latestYear.year}, after tax`]
    ]);
    $('fund-balance').innerHTML = statRows([
      ['Cash & short-term investments', compactMoney(b.cash), `as of ${b.end}`],
      ['Total debt', compactMoney(b.debt), 'borrowings, excluding leases'],
      [b.netDebt > 0 ? 'Net debt' : 'Net cash', compactMoney(Math.abs(b.netDebt)), 'debt − cash'],
      ['Debt / free cash flow', b.debtToFcf == null ? '—' : `${number(b.debtToFcf, 1)} yrs`, 'years of TTM FCF to repay']
    ]);
    $('fund-valuation').innerHTML = statRows([
      ['Market cap', compactMoney(v.marketCap), `${compactNumber(F.shares)} shares × ${money(F.price)}`],
      ['Enterprise value', compactMoney(v.ev), 'market cap + debt − cash'],
      ['P/E · P/FCF', `${multiple(v.pe)} · ${multiple(v.pfcf)}`, 'trailing twelve months'],
      ['FCF yield', plainPercent(v.fcfYield), `TTM FCF ${compactMoney(v.ttmFcf)}`],
      ['EV/EBIT · EV/EBITDA', `${multiple(v.evEbit)} · ${multiple(v.evEbitda)}`, 'trailing twelve months']
    ]) + needsPrice;
    const betaText = c.beta ? `${number(c.betaUsed, 2)}` : market ? '1.00' : '…';
    const betaHint = c.beta ? `${c.beta.months} months vs S&P 500, raw ${number(c.beta.raw, 2)}` : depthOf(company) < DEPTH.full ? 'load the price chart to measure; using 1.0' : market ? 'not enough overlapping history; using 1.0' : 'loading';
    $('fund-capital').innerHTML = statRows([
      ['Risk-free rate', c.riskFree == null ? (market ? 'Unavailable' : '…') : plainPercent(c.riskFree, 2), market?.riskFree ? `10-yr Treasury, FRED, ${market.riskFree.date}` : '10-yr Treasury, FRED'],
      ['Beta', betaText, betaHint],
      ['Cost of equity', plainPercent(c.costEquity), 'risk-free + beta × premium'],
      ['Cost of debt (pre-tax)', plainPercent(c.costDebt), c.costDebtEstimated ? 'interest not reported; risk-free + 1.5%' : 'interest expense ÷ average debt'],
      ['WACC', plainPercent(c.wacc), c.equityWeight == null ? (hasPrice ? '' : 'needs the current price for weights') : `${plainPercent(c.equityWeight, 0)} equity · tax ${plainPercent(c.taxRate, 0)}`],
      ['ROIC − WACC', `<span class="${c.roicSpread == null ? '' : c.roicSpread >= 0 ? 'positive' : 'negative'}">${percent(c.roicSpread)}</span>`, c.roicSpread == null ? '' : c.roicSpread >= 0 ? 'creating value' : 'earning less than its cost of capital']
    ]);
    $('dcf-growth').placeholder = number(F.dcf.defaultGrowth * 100, 1);
    $('dcf-discount').placeholder = c.wacc == null ? '9.0' : number(c.wacc * 100, 2);
    const dcf = F.dcf.result;
    setText('dcf-value', dcf ? money(dcf.value) : '—');
    setText('dcf-safety', F.dcf.marginOfSafety == null ? '—' : `${plainPercent(Math.abs(F.dcf.marginOfSafety))} ${F.dcf.marginOfSafety >= 0 ? 'below' : 'above'}`);
    $('dcf-safety').className = F.dcf.marginOfSafety == null ? '' : F.dcf.marginOfSafety >= 0 ? 'positive' : 'negative';
    setText('dcf-detail', dcf
      ? `Starting FCF/share ${money(F.dcf.fcfPerShare)} (TTM). Growth ${plainPercent(F.dcf.growth)} → terminal ${plainPercent(F.dcf.terminalGrowth)}, discounted at ${plainPercent(F.dcf.discount, 2)}. Terminal value is ${plainPercent(dcf.terminalShare, 0)} of the total.${hasPrice ? ` The price is ${money(F.price)}.` : ' Add the current price to compare.'}`
      : F.dcf.fcfPerShare > 0 ? 'The discount rate must exceed terminal growth by at least 0.5%.' : 'Free cash flow is negative or missing, so a cash-flow valuation is not meaningful.');
    renderFundamentalTable(F);
    renderRival();
    renderPeers(F);
  }

  function renderFundamentalTable(F) {
    const years = F.years.filter((year) => Number.isFinite(year.revenue)).slice(-10);
    const row = (label, render) => `<tr><td>${label}</td>${years.map((year) => `<td>${render(year)}</td>`).join('')}</tr>`;
    $('fund-table').innerHTML = `<thead><tr><th>FISCAL YEAR</th>${years.map((year) => `<th title="Period ending ${escapeHtml(year.end)}">${year.year}</th>`).join('')}</tr></thead><tbody>${[
      row('Revenue', (y) => compactMoney(y.revenue)),
      row('Gross margin', (y) => plainPercent(y.grossMargin)),
      row('Operating margin', (y) => plainPercent(y.operatingMargin)),
      row('Net income', (y) => compactMoney(y.netIncome)),
      row('Operating cash flow', (y) => compactMoney(y.operatingCashFlow)),
      row('Capital expenditures', (y) => compactMoney(y.capex)),
      row('Free cash flow', (y) => compactMoney(y.fcf)),
      row('FCF margin', (y) => plainPercent(y.fcfMargin)),
      row('FCF / share', (y) => money(y.fcfPerShare)),
      row('Diluted EPS', (y) => y.eps == null ? '—' : money(y.eps)),
      row('Dividends / share', (y) => y.dividend == null ? '—' : money(y.dividend)),
      row('Diluted shares', (y) => compactNumber(y.dilutedShares)),
      row('Cash & ST investments', (y) => compactMoney(y.cash)),
      row('Total debt', (y) => compactMoney(y.debt)),
      row('Net debt (cash)', (y) => compactMoney(y.netDebt)),
      row('ROIC', (y) => plainPercent(y.roic))
    ].join('')}</tbody>`;
    $('fund-table').parentElement.scrollLeft = $('fund-table').parentElement.scrollWidth;
  }

  const peerLists = readStore('lattice.peers.v1', {});
  const peerData = readStore('lattice.peerdata.v1', {});
  for (const [ticker, company] of Object.entries(peerData)) if (!company?.fetchedAt || Date.now() - Date.parse(company.fetchedAt) > API_CACHE_MS || !('ttm' in company)) delete peerData[ticker];
  // Peers need a price for valuation, so an SEC-only copy in `companies` doesn't count.
  const peerCompany = (ticker) => companies[ticker]?.source === 'api' && depthOf(companies[ticker]) >= DEPTH.price ? companies[ticker] : peerData[ticker];
  function peerMessage(message, kind = '') { $('peer-message').textContent = message; $('peer-message').className = `api-message peer-message ${kind}`; }

  function renderPeers(F) {
    const peers = peerLists[selectedTicker] || [];
    const line = (company, metrics, self) => {
      const v = metrics?.valuation, p = metrics?.profitability, g = metrics?.growth;
      return `<tr class="${self ? 'self' : ''}"><td>${escapeHtml(company?.name || '')} <span class="ticker-tag">${escapeHtml(company?.ticker || '')}</span></td><td>${money(metrics?.price)}</td><td>${compactMoney(v?.marketCap)}</td><td>${multiple(v?.pe)}</td><td>${multiple(v?.pfcf)}</td><td>${multiple(v?.evEbit)}</td><td>${plainPercent(v?.fcfYield)}</td><td>${plainPercent(p?.grossMargin)}</td><td>${plainPercent(p?.operatingMargin)}</td><td>${percent(g?.revenue5)}</td><td>${plainPercent(p?.roic)}</td><td>${self ? '' : `<button data-remove-peer="${escapeHtml(company.ticker)}" aria-label="Remove ${escapeHtml(company.ticker)}">Remove</button>`}</td></tr>`;
    };
    const rows = peers.map((ticker) => {
      const company = peerCompany(ticker);
      if (!company) return `<tr><td>${escapeHtml(ticker)}</td><td colspan="10">Loading…</td><td><button data-remove-peer="${escapeHtml(ticker)}">Remove</button></td></tr>`;
      return line(company, hasStatements(company) ? fundamentalsFor(company, false) : null, false);
    });
    $('peer-table').innerHTML = `<thead><tr><th>COMPANY</th><th>PRICE</th><th>MARKET CAP</th><th>P/E</th><th>P/FCF</th><th>EV/EBIT</th><th>FCF YIELD</th><th>GROSS MARGIN</th><th>OP. MARGIN</th><th>REV. CAGR 5Y</th><th>ROIC</th><th></th></tr></thead><tbody>${line(companies[selectedTicker], F, true)}${rows.join('')}</tbody>`;
  }

  async function addPeers() {
    if (!selectedTicker) return;
    const tickers = [...new Set($('peer-input').value.toUpperCase().split(/[\s,]+/).filter((item) => /^[A-Z0-9.\-]{1,12}$/.test(item) && item !== selectedTicker))];
    if (!tickers.length) { peerMessage('Enter one or more tickers, separated by commas.', 'error'); return; }
    const list = peerLists[selectedTicker] || [];
    peerLists[selectedTicker] = [...list, ...tickers.filter((ticker) => !list.includes(ticker))].slice(0, 12);
    saveStore('lattice.peers.v1', peerLists);
    $('peer-input').value = '';
    renderFundamentals();
    const failed = [];
    for (const ticker of tickers) {
      if (peerCompany(ticker)) continue;
      try {
        const response = await fetch(`/api/company?symbol=${encodeURIComponent(ticker)}&depth=price`);
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw Error(result.error || 'Could not load.');
        peerData[ticker] = result;
        saveStore('lattice.peerdata.v1', peerData);
      } catch (error) {
        failed.push(`${ticker}: ${error.message}`);
        peerLists[selectedTicker] = peerLists[selectedTicker].filter((item) => item !== ticker);
        saveStore('lattice.peers.v1', peerLists);
      }
      if (view === 'fundamentals') renderFundamentals();
    }
    peerMessage(failed.join(' '), failed.length ? 'error' : '');
  }

  const compareFields = [
    ['price', 'Latest price', (f) => money(f.price)],
    ['marketCap', 'Market cap', (f) => compactMoney(f.valuation.marketCap)],
    ['enterpriseValue', 'Enterprise value', (f) => compactMoney(f.valuation.ev)],
    ['pe', 'P/E (TTM)', (f) => multiple(f.valuation.pe)],
    ['pfcf', 'P/FCF (TTM)', (f) => multiple(f.valuation.pfcf)],
    ['evEbitda', 'EV/EBITDA (TTM)', (f) => multiple(f.valuation.evEbitda)],
    ['fcfYield', 'FCF yield (TTM)', (f) => plainPercent(f.valuation.fcfYield)],
    ['revenue', 'Revenue (FY)', (f) => compactMoney(f.latestYear.revenue)],
    ['revenueGrowth', 'Revenue CAGR (5 yr)', (f) => percent(f.growth.revenue5)],
    ['epsGrowth', 'EPS CAGR (5 yr)', (f) => percent(f.growth.eps5)],
    ['grossMargin', 'Gross margin (FY)', (f) => plainPercent(f.profitability.grossMargin)],
    ['operatingMargin', 'Operating margin (FY)', (f) => plainPercent(f.profitability.operatingMargin)],
    ['fcfMargin', 'FCF margin (FY)', (f) => plainPercent(f.profitability.fcfMargin)],
    ['roic', 'ROIC (FY)', (f) => plainPercent(f.profitability.roic)],
    ['freeCashFlow', 'Free cash flow (TTM)', (f) => compactMoney(f.valuation.ttmFcf)],
    ['cash', 'Cash & short-term investments', (f) => compactMoney(f.balance.cash)],
    ['debt', 'Total debt', (f) => compactMoney(f.balance.debt)],
    ['netDebt', 'Net debt (cash)', (f) => compactMoney(f.balance.netDebt)]
  ];
  const defaultCompareFields = ['price', 'marketCap', 'pe', 'revenue', 'revenueGrowth', 'operatingMargin', 'fcfYield', 'roic'];
  const storedCompareTickers = readStore('lattice.compare.tickers.v1', null);
  let compareTickers = Array.isArray(storedCompareTickers)
    ? [...new Set(storedCompareTickers.filter((ticker) => typeof ticker === 'string' && /^[A-Z0-9.\-]{1,12}$/.test(ticker)))].slice(0, 12)
    : selectedTicker ? [selectedTicker] : [];
  const storedCompareFields = readStore('lattice.compare.fields.v1', null);
  let selectedCompareFields = Array.isArray(storedCompareFields)
    ? storedCompareFields.filter((id) => compareFields.some(([field]) => field === id))
    : defaultCompareFields;
  const compareLoading = new Set();
  const compareCompany = (ticker) => [companies[ticker], peerData[ticker]].filter((company) => company?.source === 'api' && hasStatements(company))
    .sort((left, right) => depthOf(right) - depthOf(left))[0] || null;
  function compareMessage(message, kind = '') {
    $('compare-message').textContent = message;
    $('compare-message').className = `api-message compare-message ${kind}`;
  }

  function renderCompare() {
    $('compare-picks').innerHTML = compareTickers.length ? compareTickers.map((ticker) =>
      `<span class="compare-chip">${escapeHtml(ticker)}<button type="button" data-remove-compare="${escapeHtml(ticker)}" aria-label="Remove ${escapeHtml(ticker)}">×</button></span>`
    ).join('') : '<span class="company-meta">No companies selected yet.</span>';
    $('compare-metrics').innerHTML = compareFields.map(([id, label]) =>
      `<label><input type="checkbox" value="${id}" ${selectedCompareFields.includes(id) ? 'checked' : ''}>${label}</label>`
    ).join('');
    if (!compareTickers.length) {
      $('compare-table').innerHTML = '<tbody><tr><td>Add a ticker to start comparing.</td></tr></tbody>';
      return;
    }
    if (!selectedCompareFields.length) {
      $('compare-table').innerHTML = '<tbody><tr><td>Select at least one metric to build the table.</td></tr></tbody>';
      return;
    }
    const cells = compareTickers.map((ticker) => {
      const company = compareCompany(ticker);
      return { ticker, company, metrics: company ? fundamentalsFor(company, false) : null };
    });
    const header = cells.map(({ ticker, company, metrics }) => `<th scope="col"><strong>${escapeHtml(ticker)}</strong><small>${escapeHtml(company?.name || (compareLoading.has(ticker) ? 'Loading…' : 'Data unavailable'))}</small><small>${metrics ? `FY ${metrics.latestYear.year} · TTM ${escapeHtml(metrics.ttmEnd)}` : ''}</small></th>`).join('');
    const rows = compareFields.filter(([id]) => selectedCompareFields.includes(id)).map(([, label, format]) =>
      `<tr><th scope="row">${label}</th>${cells.map(({ metrics }) => `<td>${metrics ? format(metrics) : '—'}</td>`).join('')}</tr>`
    ).join('');
    $('compare-table').innerHTML = `<thead><tr><th scope="col">METRIC</th>${header}</tr></thead><tbody>${rows}</tbody>`;
  }

  async function addCompare() {
    const raw = $('compare-input').value.trim().toUpperCase();
    const tickers = [...new Set(raw.split(/[\s,]+/).filter(Boolean))];
    if (!tickers.length || tickers.some((ticker) => !/^[A-Z0-9.\-]{1,12}$/.test(ticker))) { compareMessage('Enter valid ticker symbols, separated by commas.', 'error'); return; }
    if (new Set([...compareTickers, ...tickers]).size > 12) { compareMessage('Compare up to 12 companies at a time.', 'error'); return; }
    compareTickers = [...new Set([...compareTickers, ...tickers])];
    saveStore('lattice.compare.tickers.v1', compareTickers);
    $('compare-input').value = '';
    compareMessage('');
    renderCompare();
    await loadCompare(tickers);
  }

  async function loadCompare(tickers) {
    const failed = [];
    for (const ticker of tickers) {
      const cached = compareCompany(ticker);
      if ((cached && (depthOf(cached) >= DEPTH.price || cached.priceError || peerData[ticker]?.priceError)) || compareLoading.has(ticker)) continue;
      compareLoading.add(ticker);
      renderCompare();
      try {
        const response = await fetch(`/api/company?symbol=${encodeURIComponent(ticker)}&depth=price`);
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw Error(result.error || 'Could not load company data.');
        if (!hasStatements(result)) throw Error('SEC financial statements are unavailable.');
        peerData[ticker] = result;
        saveStore('lattice.peerdata.v1', peerData);
      } catch (error) {
        failed.push(`${ticker}: ${error.message}`);
        compareTickers = compareTickers.filter((item) => item !== ticker);
        saveStore('lattice.compare.tickers.v1', compareTickers);
      } finally {
        compareLoading.delete(ticker);
        if (view === 'compare') renderCompare();
      }
    }
    compareMessage(failed.join(' '), failed.length ? 'error' : '');
  }

  // Closest competitor for each ticker, compared on a ten-year record. Its data is cached with the peers.
  const rivals = readStore('lattice.rivals.v1', {});
  const rivalLoads = new Set();
  function rivalMessage(message, kind = '') { $('rival-message').textContent = message; $('rival-message').className = `api-message peer-message ${kind}`; }
  const rivalCompany = (ticker) => [companies[ticker], peerData[ticker]].find((company) => company?.source === 'api' && depthOf(company) >= DEPTH.full) || null;

  async function loadRival(ticker, owner) {
    rivalLoads.add(ticker);
    rivalMessage(`Loading ${ticker}'s filings and prices…`);
    try {
      const response = await fetch(`/api/company?symbol=${encodeURIComponent(ticker)}&depth=full`);
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(result.error || 'Could not load.');
      if (depthOf(result) < DEPTH.full) throw Error(result.priceError || 'No price history is available.');
      peerData[ticker] = result;
      saveStore('lattice.peerdata.v1', peerData);
      rivalMessage('');
    } catch (error) {
      rivalMessage(`${ticker}: ${error.message}`, 'error');
      if (rivals[owner] === ticker) { delete rivals[owner]; saveStore('lattice.rivals.v1', rivals); }
    } finally { rivalLoads.delete(ticker); }
    if (view === 'fundamentals' && owner === selectedTicker) renderRival();
  }

  function setRival(input) {
    const ticker = String(input || '').trim().toUpperCase();
    if (!selectedTicker) return;
    if (!/^[A-Z0-9.\-]{1,12}$/.test(ticker) || ticker === selectedTicker) { rivalMessage('Enter a different ticker, such as MSFT.', 'error'); return; }
    rivals[selectedTicker] = ticker;
    saveStore('lattice.rivals.v1', rivals);
    $('rival-input').value = '';
    rivalMessage('');
    renderRival();
  }

  function renderRival() {
    const company = companies[selectedTicker];
    const rival = rivals[selectedTicker];
    const picks = (peerLists[selectedTicker] || []).filter((ticker) => ticker !== rival);
    $('rival-picks').innerHTML = picks.length ? `<span class="company-meta">From your peers:</span>${picks.map((ticker) => `<button class="ticker-chip" data-rival="${escapeHtml(ticker)}" type="button">${escapeHtml(ticker)}</button>`).join('')}` : '';
    $('rival-summary').innerHTML = '';
    if (!company || !rival) {
      $('rival-table').innerHTML = '<tbody><tr><td>Enter the closest competitor to compare ten years of net income, dividends and share price side by side.</td></tr></tbody>';
      return;
    }
    const other = rivalCompany(rival);
    if (!other) {
      $('rival-table').innerHTML = `<tbody><tr><td>Loading ${escapeHtml(rival)}…</td></tr></tbody>`;
      if (!rivalLoads.has(rival)) loadRival(rival, selectedTicker);
      return;
    }
    const mine = M.yearRecord(company).filter((year) => year.netIncome != null || year.eps != null).slice(-10);
    const theirs = new Map(M.yearRecord(other).map((year) => [year.year, year]));
    const matched = mine.map((year) => theirs.get(year.year)).filter(Boolean);
    const tag = (item) => `<span class="ticker-tag">${escapeHtml(item.ticker)}</span>`;
    const stat = (label, key) => `<div class="rival-stat">${label}<strong>${percent(M.recordGrowth(mine, key))} <span>${escapeHtml(company.ticker)}</span> · ${percent(M.recordGrowth(matched, key))} <span>${escapeHtml(other.ticker)}</span></strong></div>`;
    $('rival-summary').innerHTML = [stat('Net income growth / year', 'netIncome'), stat('EPS growth / year', 'eps'), stat('Dividend growth / year', 'dividend'), stat('Share price growth / year', 'price')].join('');
    const change = (value) => `<span class="${value == null ? '' : value >= 0 ? 'positive' : 'negative'}">${percent(value, 0)}</span>`;
    const metrics = [
      ['Net income', (year) => compactMoney(year?.netIncome)],
      ['Diluted EPS', (year) => money(year?.eps)],
      ['Dividends / share', (year) => year?.dividend == null ? '—' : money(year.dividend)],
      ['Year-end price', (year) => money(year?.price)],
      ['Price change', (year) => change(year?.priceChange)]
    ];
    const cells = (render, pick) => mine.map((year) => { const item = pick(year); return `<td${item ? ` title="Fiscal year ending ${escapeHtml(item.end)}"` : ''}>${item ? render(item) : '—'}</td>`; }).join('');
    $('rival-table').innerHTML = `<thead><tr><th>FISCAL YEAR</th>${mine.map((year) => `<th>${year.year}</th>`).join('')}</tr></thead><tbody>${metrics.map(([label, render]) =>
      `<tr class="metric-start"><td>${label} ${tag(company)}</td>${cells(render, (year) => year)}</tr><tr class="rival"><td>${label} ${tag(other)}</td>${cells(render, (year) => theirs.get(year.year))}</tr>`
    ).join('')}</tbody>`;
    $('rival-table').parentElement.scrollLeft = $('rival-table').parentElement.scrollWidth;
    const lastEnd = (item) => M.yearRecord(item).at(-1)?.end;
    const monthDay = (date) => date ? new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(`${date}T00:00:00Z`)) : '—';
    if (lastEnd(company)?.slice(5, 7) !== lastEnd(other)?.slice(5, 7)) {
      $('rival-summary').insertAdjacentHTML('beforeend', `<div class="rival-note">Fiscal years are matched by their label, but they end at different times: ${escapeHtml(company.ticker)} around ${monthDay(lastEnd(company))}, ${escapeHtml(other.ticker)} around ${monthDay(lastEnd(other))}. Hover a figure for its exact period.</div>`);
    }
  }

  function renderPortfolio() {
    const priced = (ticker) => companies[ticker]?.rows?.length > 0;
    const active = holdings.filter((item) => priced(item.ticker) && item.shares > 0);
    const missing = holdings.filter((item) => !priced(item.ticker) && item.shares > 0);
    const totalValue = active.reduce((sum, item) => sum + item.shares * companies[item.ticker].rows.at(-1).price, 0);
    const totalCost = holdings.reduce((sum, item) => sum + item.shares * item.cost, 0);
    setText('portfolio-value', missing.length ? '—' : money(totalValue));
    setText('portfolio-cost', money(totalCost));
    setText('portfolio-gain', missing.length ? '—' : money(totalValue - totalCost));
    $('portfolio-gain').className = `metric-value ${totalValue - totalCost >= 0 ? 'positive' : 'negative'}`;
    setText('holding-count', holdings.length);
    const missingNotice = missing.length ? `<div class="api-message">Load prices for ${missing.map((item) => escapeHtml(item.ticker)).join(', ')} (open the ticker, then Load prices) to calculate the full portfolio value.</div>` : '';
    $('holdings-content').innerHTML = missingNotice + (active.length ? `<table class="holdings-table"><thead><tr><th>COMPANY</th><th>SHARES</th><th>AVG COST</th><th>LATEST PRICE</th><th>MARKET VALUE</th><th>GAIN / LOSS</th><th></th></tr></thead><tbody>${active.map((item) => { const company = companies[item.ticker]; const price = company.rows.at(-1).price; const gain = item.shares * (price - item.cost); return `<tr><td>${escapeHtml(company.name)} <span class="ticker-tag">${escapeHtml(item.ticker)}</span></td><td>${number(item.shares, 3)}</td><td>${money(item.cost)}</td><td>${money(price)}</td><td>${money(item.shares * price)}</td><td class="${gain >= 0 ? 'positive' : 'negative'}">${money(gain)}</td><td><button data-remove="${escapeHtml(item.ticker)}" aria-label="Remove ${escapeHtml(item.ticker)} holding">Remove</button></td></tr>`; }).join('')}</tbody></table>` : missing.length ? '' : '<div class="empty-state"><span class="empty-icon">▥</span><strong>No holdings yet</strong>Add a position to see your portfolio value here.</div>');
  }

  function parseCsv(text) {
    const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((line) => line.trim());
    const split = (line) => { const fields = []; let field = '', quoted = false; for (let i = 0; i < line.length; i++) { const c = line[i]; if (c === '"' && quoted && line[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = !quoted; else if (c === ',' && !quoted) { fields.push(field.trim()); field = ''; } else field += c; } fields.push(field.trim()); return fields; };
    if (lines.length < 3) throw Error('Add a header and at least two data rows.');
    const headers = split(lines.shift()).map((field) => field.toLowerCase());
    for (const required of ['date', 'price', 'eps']) if (!headers.includes(required)) throw Error(`Missing required column: ${required}`);
    const rows = lines.map((line, index) => { const values = split(line); const get = (name) => values[headers.indexOf(name)]; const date = get('date'); const parsedDate = new Date(`${date}T00:00:00Z`); const priceText = get('price'); const epsText = get('eps'); const price = Number(priceText); const eps = Number(epsText); const dividend = headers.includes('dividend') ? Number(get('dividend') || 0) : 0; if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date || !priceText || !epsText || !Number.isFinite(price) || price <= 0 || !Number.isFinite(eps) || !Number.isFinite(dividend)) throw Error(`Invalid data on CSV row ${index + 2}.`); return { date, price, eps, dividend }; });
    rows.sort((a, b) => a.date.localeCompare(b.date));
    if (new Set(rows.map((row) => row.date)).size !== rows.length) throw Error('Each date must appear only once.');
    return rows;
  }

  function openImport() { $('import-error').textContent = ''; $('import-dialog').showModal(); }
  function openHolding() {
    if (!Object.keys(companies).length) { showView('research'); depthMessage('Load a ticker first, then add it as a holding.', 'error'); return; }
    $('holding-error').textContent = ''; $('holding-ticker').innerHTML = Object.values(companies).map((company) => `<option value="${escapeHtml(company.ticker)}">${escapeHtml(company.name)} (${escapeHtml(company.ticker)})</option>`).join(''); $('holding-ticker').value = selectedTicker; $('holding-dialog').showModal();
  }

  $('ticker-chips').addEventListener('click', (event) => { const button = event.target.closest('[data-ticker]'); if (button) selectTicker(button.dataset.ticker); });
  $('ticker-search').addEventListener('input', (event) => renderChips(event.target.value));
  $('ticker-search').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); const ticker = $('ticker-search').value.trim().toUpperCase(); if (companies[ticker]) selectTicker(ticker); else loadTicker(ticker); } });
  $('load-ticker').addEventListener('click', () => loadTicker($('ticker-search').value));
  document.addEventListener('click', (event) => { const button = event.target.closest('.depth-button'); if (button && selectedTicker) loadTicker(selectedTicker, button.dataset.depth); });
  document.addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); showView('research'); $('ticker-search').focus(); } });
  document.querySelectorAll('.nav-link').forEach((link) => link.addEventListener('click', (event) => { event.preventDefault(); showView(link.dataset.view); }));
  window.addEventListener('hashchange', () => showView(location.hash.slice(1)));
  $('window-options').addEventListener('click', (event) => { const button = event.target.closest('[data-years]'); if (!button) return; selectedYears = Number(button.dataset.years); $('window-options').querySelectorAll('button').forEach((item) => item.classList.toggle('selected', item === button)); renderResearch(); });
  $('multiple-options').addEventListener('click', (event) => { const button = event.target.closest('[data-multiple]'); if (!button) return; multipleMode = button.dataset.multiple; $('multiple-options').querySelectorAll('button').forEach((item) => item.classList.toggle('selected', item === button)); renderResearch(); });
  $('scenario-toggle').addEventListener('change', renderResearch);
  for (const id of ['erp-input', 'dcf-growth', 'dcf-terminal', 'dcf-discount']) $(id).addEventListener('input', renderFundamentals);
  $('peer-add').addEventListener('click', addPeers);
  $('compare-add').addEventListener('click', addCompare);
  $('compare-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); addCompare(); } });
  $('compare-picks').addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-compare]');
    if (!button) return;
    compareTickers = compareTickers.filter((ticker) => ticker !== button.dataset.removeCompare);
    saveStore('lattice.compare.tickers.v1', compareTickers);
    renderCompare();
  });
  $('compare-metrics').addEventListener('change', (event) => {
    if (!event.target.matches('input[type="checkbox"]')) return;
    selectedCompareFields = [...$('compare-metrics').querySelectorAll('input:checked')].map((input) => input.value);
    saveStore('lattice.compare.fields.v1', selectedCompareFields);
    renderCompare();
  });
  $('rival-set').addEventListener('click', () => setRival($('rival-input').value));
  $('rival-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); setRival($('rival-input').value); } });
  $('rival-picks').addEventListener('click', (event) => { const button = event.target.closest('[data-rival]'); if (button) setRival(button.dataset.rival); });
  $('peer-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); addPeers(); } });
  $('peer-table').addEventListener('click', (event) => { const button = event.target.closest('[data-remove-peer]'); if (!button) return; peerLists[selectedTicker] = (peerLists[selectedTicker] || []).filter((ticker) => ticker !== button.dataset.removePeer); saveStore('lattice.peers.v1', peerLists); renderFundamentals(); });
  $('growth-input').addEventListener('input', renderResearch);
  $('exit-pe-input').addEventListener('input', () => { manualExitPe = $('exit-pe-input').value !== ''; renderResearch(); });
  $('import-open').addEventListener('click', openImport);
  $('method-import').addEventListener('click', openImport);
  $('import-cancel').addEventListener('click', () => $('import-dialog').close());
  $('import-submit').addEventListener('click', async () => { try { const ticker = $('import-ticker').value.trim().toUpperCase(); const name = $('import-name').value.trim(); const sector = $('import-sector').value.trim(); const file = $('import-file').files[0]; if (!/^[A-Z0-9.\-]{1,12}$/.test(ticker)) throw Error('Enter a ticker using letters, numbers, dot or hyphen.'); if (!name) throw Error('Enter a company name.'); if (!file) throw Error('Choose a CSV file.'); if (file.size > 5_000_000) throw Error('Choose a CSV smaller than 5 MB.'); const rows = parseCsv(await file.text()); const company = { ticker, name, sector, source: 'import', rows }; const next = { ...imported, [ticker]: company }; if (!saveStore('lattice.imported.v1', next)) throw Error('Browser storage is full. Try a smaller CSV.'); Object.assign(imported, next); companies[ticker] = company; $('import-dialog').close(); selectTicker(ticker); showView('research'); } catch (error) { $('import-error').textContent = error.message; } });
  $('add-holding-open').addEventListener('click', openHolding);
  $('portfolio-add').addEventListener('click', openHolding);
  $('holding-cancel').addEventListener('click', () => $('holding-dialog').close());
  $('holding-submit').addEventListener('click', () => { const ticker = $('holding-ticker').value; const shares = Number($('holding-shares').value); const cost = Number($('holding-cost').value); if (!companies[ticker] || !Number.isFinite(shares) || shares <= 0 || !Number.isFinite(cost) || cost < 0 || $('holding-cost').value === '') { $('holding-error').textContent = 'Enter a valid company, positive share count and nonnegative cost.'; return; } const next = [...holdings.filter((item) => item.ticker !== ticker), { ticker, shares, cost }]; if (!saveStore('lattice.holdings.v1', next)) { $('holding-error').textContent = 'Could not save this holding in browser storage.'; return; } holdings = next; $('holding-dialog').close(); renderPortfolio(); showView('portfolio'); });
  $('holdings-content').addEventListener('click', (event) => { const button = event.target.closest('[data-remove]'); if (!button) return; holdings = holdings.filter((item) => item.ticker !== button.dataset.remove); saveStore('lattice.holdings.v1', holdings); renderPortfolio(); });
  let resizeFrame = 0;
  new ResizeObserver(() => { cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(() => { if (currentResult && view === 'research') renderChart(currentResult); }); }).observe($('valuation-chart'));

  setText('today-label', new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).format(new Date()));
  // Keeps prices current for the selected ticker and every holding. The server answers from its cache
  // plus a quote it refreshes at most once a minute, so this costs no new filing or history requests.
  let refreshing = false;
  async function refreshPrices() {
    if (document.hidden || refreshing) return;
    refreshing = true;
    try {
      const tickers = new Set([selectedTicker, ...holdings.map((item) => item.ticker)]);
      for (const ticker of tickers) {
        const company = companies[ticker];
        if (company?.source !== 'api' || depthOf(company) < DEPTH.full) continue;
        try {
          const response = await fetch(`/api/company?symbol=${encodeURIComponent(ticker)}&depth=full`);
          if (!response.ok) continue;
          const result = await response.json();
          if (!Array.isArray(result.rows) || !result.rows.length || depthOf(result) < DEPTH.full) continue;
          companies[ticker] = result;
          apiCache[ticker] = result;
        } catch { continue; }
        if (ticker === selectedTicker) { renderResearch(); if (view === 'fundamentals') renderFundamentals(); }
      }
      saveStore('lattice.api.v1', apiCache);
      renderPortfolio();
    } finally { refreshing = false; }
  }

  renderChips(); renderResearch(); renderPortfolio(); showView(location.hash.slice(1) || (new URLSearchParams(location.search).has('ticker') ? 'research' : 'notes')); checkApiStatus();
  // Shareable links: /app?ticker=AAPL opens that company with prices; add &depth=sec for filings only.
  const params = new URLSearchParams(location.search);
  const linked = (params.get('ticker') || '').trim().toUpperCase();
  const linkedDepth = params.get('depth') === 'sec' ? 'sec' : 'full';
  if (linked) loadTicker(linked, linkedDepth);
  refreshPrices();
  setInterval(refreshPrices, LIVE_MS);
  document.addEventListener('visibilitychange', refreshPrices);
})();
