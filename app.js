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

  function demoRows(profile) {
    const rows = [];
    const startYear = 2006;
    const months = 249;
    for (let i = 0; i < months; i++) {
      const year = startYear + Math.floor(i / 12);
      const month = i % 12;
      if (year > 2026 || (year === 2026 && month > 8)) break;
      const t = i / 12;
      const cycle = Math.sin(i * 0.11 + profile.phase) * 0.12 + Math.sin(i * 0.035 + profile.phase) * 0.09;
      const eps = profile.eps * Math.exp(profile.growth * t) * (1 + Math.sin(i * 0.08 + profile.phase) * 0.045);
      const pe = profile.pe * (1 + cycle + Math.sin(i * 0.025 + profile.phase * 2) * 0.13);
      const price = Math.max(1, eps * pe);
      const dividend = profile.eps * Math.exp(profile.growth * Math.floor(t)) * profile.payout;
      rows.push({ date: `${year}-${String(month + 1).padStart(2, '0')}-01`, price: +price.toFixed(2), eps: +eps.toFixed(3), dividend: +dividend.toFixed(3) });
    }
    return rows;
  }

  const demoProfiles = [
    { ticker: 'NSTR', name: 'Northstar Systems', sector: 'Technology', eps: 1.75, growth: .075, pe: 22, phase: .5, payout: .18 },
    { ticker: 'AVEN', name: 'Avenbrook Health', sector: 'Healthcare', eps: 2.2, growth: .052, pe: 18, phase: 2.1, payout: .42 },
    { ticker: 'MRDN', name: 'Meridian Retail', sector: 'Consumer', eps: 1.3, growth: .061, pe: 16, phase: 3.5, payout: .33 },
    { ticker: 'CRST', name: 'Crestline Energy', sector: 'Energy', eps: 3.1, growth: .031, pe: 12, phase: 5.2, payout: .58 }
  ];
  const companies = Object.fromEntries(demoProfiles.map((profile) => [profile.ticker, { ...profile, source: 'demo', rows: demoRows(profile) }]));
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
  let selectedTicker = companies[readStore('lattice.selected.v1', 'NSTR')] ? readStore('lattice.selected.v1', 'NSTR') : Object.keys(companies)[0];
  let selectedYears = 10;
  let multipleMode = 'graham';
  let view = 'research';
  let currentResult = null;
  let manualExitPe = false;

  function setText(id, value) { $(id).textContent = value; }
  function showView(next) {
    const views = ['research', 'fundamentals', 'portfolio', 'methodology'];
    view = views.includes(next) ? next : 'research';
    for (const item of views) $(`${item}-view`).hidden = item !== view;
    document.querySelectorAll('.nav-link').forEach((link) => link.classList.toggle('active', link.dataset.view === view));
    setText('breadcrumb-current', view.toUpperCase());
    if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
    if (view === 'portfolio') renderPortfolio();
    if (view === 'research' && currentResult) renderChart(currentResult);
    if (view === 'fundamentals') renderFundamentals();
  }

  function renderChips(query = '') {
    const candidates = Object.values(companies).filter((company) => `${company.ticker} ${company.name}`.toLowerCase().includes(query.toLowerCase()));
    $('ticker-chips').innerHTML = candidates.length
      ? candidates.map((company) => `<button class="ticker-chip ${company.ticker === selectedTicker ? 'selected' : ''}" data-ticker="${escapeHtml(company.ticker)}">${escapeHtml(company.ticker)}</button>`).join('')
      : '<span class="company-meta">Press Enter or Load real ticker to fetch this symbol.</span>';
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

  function apiMessage(message, kind = '') {
    $('api-message').textContent = message;
    $('api-message').className = `api-message ${kind}`;
  }

  async function checkApiStatus() {
    try {
      const response = await fetch('/api/status');
      if (!response.ok) throw Error('Server unavailable');
      const status = await response.json();
      $('sign-out').hidden = !status.signOut;
      setText('sidebar-data-status', status.configured ? 'Market data connected' : 'API key needed');
      setText('sidebar-data-help', status.configured ? 'Enter a U.S. ticker and press Load real ticker. Prices from FinancialData.net, earnings from SEC filings.' : 'Add a FinancialData.net key to .env.local, then restart the server.');
    } catch {
      setText('sidebar-data-status', 'Demo data active');
      setText('sidebar-data-help', 'Start the local server to load real market data.');
    }
  }

  async function loadRealTicker() {
    const ticker = $('ticker-search').value.trim().toUpperCase();
    if (!/^[A-Z0-9.\-]{1,12}$/.test(ticker)) { apiMessage('Enter a valid ticker symbol, such as MSFT.', 'error'); return; }
    if (ticker === 'APPL') { apiMessage('Apple trades as AAPL. Enter AAPL to load its data.', 'error'); return; }
    $('load-ticker').disabled = true;
    apiMessage(`Loading ${ticker} prices and SEC filings…`);
    try {
      const response = await fetch(`/api/company?symbol=${encodeURIComponent(ticker)}`);
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(result.error || 'Could not load company data.');
      if (!Array.isArray(result.rows) || result.rows.length < 2) throw Error('The provider returned too little data to chart.');
      companies[ticker] = result;
      apiCache[ticker] = result;
      saveStore('lattice.api.v1', apiCache);
      selectTicker(ticker);
      const splits = result.splits?.length ? ` Adjusted for ${result.splits.length} stock split${result.splits.length > 1 ? 's' : ''}.` : '';
      apiMessage(result.stale
        ? `Showing ${result.name} data from ${String(result.fetchedAt).slice(0, 10)}; today's live-data allowance has been reached.`
        : `${result.name} loaded: ${result.rows[0].date.slice(0, 4)}–${result.rows.at(-1).date.slice(0, 7)}.${splits}`, result.stale ? '' : 'success');
      renderPortfolio();
    } catch (error) { apiMessage(error.message || 'Could not load market data.', 'error'); }
    finally { $('load-ticker').disabled = false; }
  }

  function areaMultiple(result) {
    return multipleMode === 'normal' && result?.normalPe != null ? result.normalPe : M.GRAHAM_PE;
  }

  function renderResearch() {
    const company = companies[selectedTicker];
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
    setText('company-avatar', company.name.charAt(0).toUpperCase());
    setText('company-name', company.name);
    setText('company-ticker', company.ticker);
    const sourceLabel = company.source === 'demo' ? 'Synthetic company' : company.source === 'api' ? `${company.provider || 'Market data'} · updated ${String(company.fetchedAt || '').slice(0, 10)}` : 'Imported data';
    setText('company-meta', `${company.sector || 'Unclassified'} · ${sourceLabel}`);
    setText('source-badge', company.source === 'demo' ? 'SYNTHETIC DEMO DATA' : company.source === 'api' ? 'REAL MARKET DATA' : 'IMPORTED DATA');
    setText('chart-footnote', company.methodologyNote || 'Normal P/E is the median observed P/E within the selected period. Prices and EPS must use the same share basis.');
    setText('metric-price', money(result?.latest.price));
    setText('metric-price-date', result ? `Month-end close, ${result.latest.date}` : 'No valid data');
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
    setText('fund-avatar', company.name.charAt(0).toUpperCase());
    setText('fund-name', company.name);
    setText('fund-ticker', company.ticker);
    const F = hasStatements(company) ? fundamentalsFor(company, true) : null;
    $('fund-empty').hidden = Boolean(F);
    $('fund-content').hidden = !F;
    if (!F) { setText('fund-meta', `${company.sector || 'Unclassified'} · no statement data`); return; }
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
    ]);
    const betaText = c.beta ? `${number(c.betaUsed, 2)}` : market ? '1.00' : '…';
    $('fund-capital').innerHTML = statRows([
      ['Risk-free rate', c.riskFree == null ? (market ? 'Unavailable' : '…') : plainPercent(c.riskFree, 2), market?.riskFree ? `10-yr Treasury, FRED, ${market.riskFree.date}` : '10-yr Treasury, FRED'],
      ['Beta', betaText, c.beta ? `${c.beta.months} months vs S&P 500, raw ${number(c.beta.raw, 2)}` : market ? 'market history unavailable; using 1.0' : 'loading'],
      ['Cost of equity', plainPercent(c.costEquity), 'risk-free + beta × premium'],
      ['Cost of debt (pre-tax)', plainPercent(c.costDebt), c.costDebtEstimated ? 'interest not reported; risk-free + 1.5%' : 'interest expense ÷ average debt'],
      ['WACC', plainPercent(c.wacc), c.equityWeight == null ? '' : `${plainPercent(c.equityWeight, 0)} equity · tax ${plainPercent(c.taxRate, 0)}`],
      ['ROIC − WACC', `<span class="${c.roicSpread == null ? '' : c.roicSpread >= 0 ? 'positive' : 'negative'}">${percent(c.roicSpread)}</span>`, c.roicSpread == null ? '' : c.roicSpread >= 0 ? 'creating value' : 'earning less than its cost of capital']
    ]);
    $('dcf-growth').placeholder = number(F.dcf.defaultGrowth * 100, 1);
    $('dcf-discount').placeholder = c.wacc == null ? '9.0' : number(c.wacc * 100, 2);
    const dcf = F.dcf.result;
    setText('dcf-value', dcf ? money(dcf.value) : '—');
    setText('dcf-safety', F.dcf.marginOfSafety == null ? '—' : `${plainPercent(Math.abs(F.dcf.marginOfSafety))} ${F.dcf.marginOfSafety >= 0 ? 'below' : 'above'}`);
    $('dcf-safety').className = F.dcf.marginOfSafety == null ? '' : F.dcf.marginOfSafety >= 0 ? 'positive' : 'negative';
    setText('dcf-detail', dcf
      ? `Starting FCF/share ${money(F.dcf.fcfPerShare)} (TTM). Growth ${plainPercent(F.dcf.growth)} → terminal ${plainPercent(F.dcf.terminalGrowth)}, discounted at ${plainPercent(F.dcf.discount, 2)}. Terminal value is ${plainPercent(dcf.terminalShare, 0)} of the total. The price is ${money(F.price)}.`
      : F.dcf.fcfPerShare > 0 ? 'The discount rate must exceed terminal growth by at least 0.5%.' : 'Free cash flow is negative or missing, so a cash-flow valuation is not meaningful.');
    renderFundamentalTable(F);
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
  const peerCompany = (ticker) => companies[ticker]?.source === 'api' ? companies[ticker] : peerData[ticker];
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
        const response = await fetch(`/api/company?symbol=${encodeURIComponent(ticker)}&depth=peer`);
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

  function renderPortfolio() {
    const active = holdings.filter((item) => companies[item.ticker] && item.shares > 0);
    const missing = holdings.filter((item) => !companies[item.ticker] && item.shares > 0);
    const totalValue = active.reduce((sum, item) => sum + item.shares * companies[item.ticker].rows.at(-1).price, 0);
    const totalCost = holdings.reduce((sum, item) => sum + item.shares * item.cost, 0);
    setText('portfolio-value', missing.length ? '—' : money(totalValue));
    setText('portfolio-cost', money(totalCost));
    setText('portfolio-gain', missing.length ? '—' : money(totalValue - totalCost));
    $('portfolio-gain').className = `metric-value ${totalValue - totalCost >= 0 ? 'positive' : 'negative'}`;
    setText('holding-count', holdings.length);
    const missingNotice = missing.length ? `<div class="api-message">Reload market data for ${missing.map((item) => escapeHtml(item.ticker)).join(', ')} to calculate the full portfolio value.</div>` : '';
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
  function openHolding() { $('holding-error').textContent = ''; $('holding-ticker').innerHTML = Object.values(companies).map((company) => `<option value="${escapeHtml(company.ticker)}">${escapeHtml(company.name)} (${escapeHtml(company.ticker)})</option>`).join(''); $('holding-ticker').value = selectedTicker; $('holding-dialog').showModal(); }

  $('ticker-chips').addEventListener('click', (event) => { const button = event.target.closest('[data-ticker]'); if (button) selectTicker(button.dataset.ticker); });
  $('ticker-search').addEventListener('input', (event) => renderChips(event.target.value));
  $('ticker-search').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); const ticker = $('ticker-search').value.trim().toUpperCase(); if (companies[ticker]) selectTicker(ticker); else loadRealTicker(); } });
  $('load-ticker').addEventListener('click', loadRealTicker);
  document.addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); showView('research'); $('ticker-search').focus(); } });
  document.querySelectorAll('.nav-link').forEach((link) => link.addEventListener('click', (event) => { event.preventDefault(); showView(link.dataset.view); }));
  window.addEventListener('hashchange', () => showView(location.hash.slice(1)));
  $('window-options').addEventListener('click', (event) => { const button = event.target.closest('[data-years]'); if (!button) return; selectedYears = Number(button.dataset.years); $('window-options').querySelectorAll('button').forEach((item) => item.classList.toggle('selected', item === button)); renderResearch(); });
  $('multiple-options').addEventListener('click', (event) => { const button = event.target.closest('[data-multiple]'); if (!button) return; multipleMode = button.dataset.multiple; $('multiple-options').querySelectorAll('button').forEach((item) => item.classList.toggle('selected', item === button)); renderResearch(); });
  $('scenario-toggle').addEventListener('change', renderResearch);
  for (const id of ['erp-input', 'dcf-growth', 'dcf-terminal', 'dcf-discount']) $(id).addEventListener('input', renderFundamentals);
  $('peer-add').addEventListener('click', addPeers);
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
  renderChips(); renderResearch(); renderPortfolio(); showView(location.hash.slice(1) || 'research'); checkApiStatus();
  // Shareable links: /app?ticker=AAPL opens that company, fetching it if needed.
  const linked = (new URLSearchParams(location.search).get('ticker') || '').trim().toUpperCase();
  if (linked) { if (companies[linked]) selectTicker(linked); else { $('ticker-search').value = linked; loadRealTicker(); } }
})();
