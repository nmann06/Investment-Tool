(() => {
  'use strict';
  const M = globalThis.ValuationMath;
  const $ = (id) => document.getElementById(id);
  const money = (value) => value == null || !Number.isFinite(value) ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value);
  const number = (value, digits = 1) => value == null || !Number.isFinite(value) ? '—' : value.toFixed(digits);
  const percent = (value, digits = 1) => value == null || !Number.isFinite(value) ? '—' : `${value >= 0 ? '+' : ''}${(value * 100).toFixed(digits)}%`;
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const readStore = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
  const saveStore = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } };

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
      rows.push({ date: `${year}-${String(month + 1).padStart(2, '0')}-01`, price: +price.toFixed(2), eps: +eps.toFixed(3), dividend: 0 });
    }
    return rows;
  }

  const demoProfiles = [
    { ticker: 'NSTR', name: 'Northstar Systems', sector: 'Technology', eps: 1.75, growth: .075, pe: 22, phase: .5 },
    { ticker: 'AVEN', name: 'Avenbrook Health', sector: 'Healthcare', eps: 2.2, growth: .052, pe: 18, phase: 2.1 },
    { ticker: 'MRDN', name: 'Meridian Retail', sector: 'Consumer', eps: 1.3, growth: .061, pe: 16, phase: 3.5 },
    { ticker: 'CRST', name: 'Crestline Energy', sector: 'Energy', eps: 3.1, growth: .031, pe: 12, phase: 5.2 }
  ];
  const companies = Object.fromEntries(demoProfiles.map((profile) => [profile.ticker, { ...profile, source: 'demo', rows: demoRows(profile) }]));
  const imported = readStore('lattice.imported.v1', {});
  for (const [ticker, company] of Object.entries(imported)) {
    if (company && Array.isArray(company.rows)) companies[ticker] = company;
  }
  let holdings = readStore('lattice.holdings.v1', []);
  if (!Array.isArray(holdings)) holdings = [];
  let selectedTicker = companies[readStore('lattice.selected.v1', 'NSTR')] ? readStore('lattice.selected.v1', 'NSTR') : Object.keys(companies)[0];
  let selectedYears = 10;
  let view = 'research';
  let chartRows = [];
  let currentResult = null;
  let manualExitPe = false;
  let apiConfigured = false;

  function setText(id, value) { $(id).textContent = value; }
  function showView(next) {
    view = ['research', 'portfolio', 'methodology'].includes(next) ? next : 'research';
    for (const item of ['research', 'portfolio', 'methodology']) $(`${item}-view`).hidden = item !== view;
    document.querySelectorAll('.nav-link').forEach((link) => link.classList.toggle('active', link.dataset.view === view));
    setText('breadcrumb-current', view.toUpperCase());
    if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
    if (view === 'portfolio') renderPortfolio();
  }

  function renderChips(query = '') {
    const candidates = Object.values(companies).filter((company) => `${company.ticker} ${company.name}`.toLowerCase().includes(query.toLowerCase()));
    $('ticker-chips').innerHTML = candidates.length
      ? candidates.map((company) => `<button class="ticker-chip ${company.ticker === selectedTicker ? 'selected' : ''}" data-ticker="${escapeHtml(company.ticker)}">${escapeHtml(company.ticker)}</button>`).join('')
      : '<span class="company-meta">No matching company. Import a CSV to add one.</span>';
  }

  function selectTicker(ticker) {
    if (!companies[ticker]) return;
    selectedTicker = ticker;
    saveStore('lattice.selected.v1', ticker);
    manualExitPe = false;
    $('exit-pe-input').value = '';
    $('ticker-search').value = '';
    renderChips();
    renderResearch();
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
      apiConfigured = Boolean(status.configured);
      setText('sidebar-data-status', apiConfigured ? 'Market API connected' : 'API key needed');
      setText('sidebar-data-help', apiConfigured ? 'Search a ticker and select Load real ticker.' : 'Add an Alpha Vantage key to .env.local, then restart the server.');
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
    apiMessage(`Loading ${ticker} from Alpha Vantage…`);
    try {
      const response = await fetch(`/api/company?symbol=${encodeURIComponent(ticker)}`);
      const result = await response.json();
      if (!response.ok) throw Error(result.error || 'Could not load company data.');
      if (!Array.isArray(result.rows) || result.rows.length < 2) throw Error('The provider returned too little data to chart.');
      companies[ticker] = result;
      selectTicker(ticker);
      apiMessage(`${ticker} loaded from Alpha Vantage. Latest observation: ${result.rows.at(-1).date}.`, 'success');
      renderPortfolio();
    } catch (error) { apiMessage(error.message || 'Could not load market data.', 'error'); }
    finally { $('load-ticker').disabled = false; }
  }

  function renderResearch() {
    const company = companies[selectedTicker];
    const growthRate = Number($('growth-input').value) / 100;
    const typedExit = Number($('exit-pe-input').value);
    const exitPe = manualExitPe && typedExit > 0 ? typedExit : null;
    const result = M.calculate(company.rows, selectedYears, growthRate, exitPe);
    currentResult = result;
    setText('company-avatar', company.name.charAt(0).toUpperCase());
    setText('company-name', company.name);
    setText('company-ticker', company.ticker);
    const sourceLabel = company.source === 'demo' ? 'Synthetic company' : company.source === 'api' ? 'Alpha Vantage data' : 'Imported data';
    setText('company-meta', `${company.sector || 'Unclassified'} · ${sourceLabel}`);
    setText('source-badge', company.source === 'demo' ? 'SYNTHETIC DEMO DATA' : company.source === 'api' ? 'ALPHA VANTAGE DATA' : 'IMPORTED DATA');
    setText('chart-footnote', company.methodologyNote || 'Fair value uses the median observed P/E within the selected period. Prices and EPS must use the same share basis.');
    setText('metric-price', money(result?.latest.price));
    setText('metric-price-date', result ? `As of ${result.latest.date}` : 'No valid data');
    setText('metric-current-pe', result?.currentPe == null ? '—' : `${number(result.currentPe)}×`);
    setText('metric-normal-pe', result?.normalPe == null ? '—' : `${number(result.normalPe)}×`);
    setText('metric-observations', result ? `Median of ${result.observationCount} valid observations` : 'Historical median');
    setText('metric-safety', percent(result?.safety));
    setText('metric-safety-detail', result?.fairValue == null ? 'Unavailable with nonpositive EPS' : 'Relative to calculated fair value');
    setText('snapshot-fair', money(result?.fairValue));
    setText('snapshot-eps', result ? `$${number(result.latest.eps, 2)}` : '—');
    setText('snapshot-growth', percent(result?.epsGrowth));
    setText('snapshot-points', result?.period.length ?? '—');
    setText('forecast-return', percent(result?.projectedReturn));
    setText('forecast-price', result?.projectedPrice == null ? 'Projected price —' : `Projected price ${money(result.projectedPrice)}`);
    if (!manualExitPe) $('exit-pe-input').placeholder = result?.normalPe == null ? '—' : number(result.normalPe);
    const ratio = result?.fairValue ? result.latest.price / result.fairValue : 1;
    $('meter-marker').style.left = `${Math.min(98, Math.max(2, 50 + (ratio - 1) * 48))}%`;
    const insight = result?.fairValue == null ? 'There is not enough positive EPS history to calculate a fair value benchmark.' : result.safety >= 0 ? `The latest price is ${number(result.safety * 100)}% below the historical earnings benchmark.` : `The latest price is ${number(-result.safety * 100)}% above the historical earnings benchmark.`;
    setText('insight-text', insight);
    renderChart(result);
  }

  function renderChart(result) {
    const svg = $('valuation-chart');
    if (!result || result.period.length < 2) { svg.innerHTML = '<text x="450" y="180" text-anchor="middle" fill="#9ba9b8" font-size="14">At least two observations are needed to draw a chart.</text>'; chartRows = []; return; }
    const rows = result.period;
    chartRows = rows;
    const left = 55, right = 846, top = 16, bottom = 318;
    const fair = rows.map((row) => row.eps > 0 && result.normalPe != null ? row.eps * result.normalPe : null);
    const maxPrice = Math.max(...rows.map((row) => row.price), ...fair.filter((v) => v != null)) * 1.15;
    const maxEps = Math.max(...rows.map((row) => Math.max(0, row.eps))) * 1.15 || 1;
    const x = (index) => left + index * (right - left) / (rows.length - 1);
    const yPrice = (value) => bottom - value / maxPrice * (bottom - top);
    const yEps = (value) => bottom - Math.max(0, value) / maxEps * (bottom - top);
    const path = (values, y) => values.map((value, index) => value == null ? null : `${index === 0 || values[index - 1] == null ? 'M' : 'L'}${x(index).toFixed(1)},${y(value).toFixed(1)}`).filter(Boolean).join(' ');
    const grid = [0, .25, .5, .75, 1].map((step) => { const yy = bottom - step * (bottom - top); return `<line x1="${left}" y1="${yy}" x2="${right}" y2="${yy}" stroke="#eaf0f5"/><text x="46" y="${yy + 3}" text-anchor="end" fill="#a0aebb" font-size="10">$${Math.round(maxPrice * step)}</text><text x="855" y="${yy + 3}" fill="#9bbeb9" font-size="10">${(maxEps * step).toFixed(1)}</text>`; }).join('');
    const ticks = [0, .25, .5, .75, 1].map((fraction) => { const index = Math.min(rows.length - 1, Math.round(fraction * (rows.length - 1))); return `<text x="${x(index)}" y="344" text-anchor="middle" fill="#a0aebb" font-size="10">${rows[index].date.slice(0, 4)}</text>`; }).join('');
    svg.innerHTML = `<defs><linearGradient id="price-fill" x1="0" x2="0" y1="0" y2="1"><stop stop-color="#6ca5d7" stop-opacity=".13"/><stop offset="1" stop-color="#6ca5d7" stop-opacity="0"/></linearGradient></defs>${grid}${ticks}<path d="${path(rows.map((row) => row.price), yPrice)}" fill="none" stroke="#4b82bc" stroke-width="2.5" vector-effect="non-scaling-stroke"/><path d="${path(fair, yPrice)}" fill="none" stroke="#d3a875" stroke-width="2" stroke-dasharray="6 5" vector-effect="non-scaling-stroke"/><path d="${path(rows.map((row) => row.eps), yEps)}" fill="none" stroke="#77bdb2" stroke-width="2" vector-effect="non-scaling-stroke"/><line id="hover-line" x1="0" x2="0" y1="${top}" y2="${bottom}" stroke="#99aabd" stroke-dasharray="3 3" visibility="hidden"/><circle id="hover-dot" r="4" fill="#4b82bc" stroke="white" stroke-width="2" visibility="hidden"/>`;
    svg.onpointermove = (event) => {
      const bounds = svg.getBoundingClientRect();
      const px = (event.clientX - bounds.left) * 900 / bounds.width;
      const index = Math.max(0, Math.min(rows.length - 1, Math.round((px - left) / (right - left) * (rows.length - 1))));
      const row = rows[index];
      const xx = x(index);
      const line = $('hover-line'), dot = $('hover-dot');
      line.setAttribute('x1', xx); line.setAttribute('x2', xx); line.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', xx); dot.setAttribute('cy', yPrice(row.price)); dot.setAttribute('visibility', 'visible');
      const tip = $('chart-tooltip');
      tip.innerHTML = `<strong>${row.date}</strong><br>Price ${money(row.price)}<br>Fair value ${money(fair[index])}<br>TTM EPS $${number(row.eps, 2)}`;
      tip.hidden = false;
      tip.style.left = `${Math.min(bounds.width - 145, Math.max(4, xx * bounds.width / 900 + 12))}px`;
      tip.style.top = `${Math.max(4, yPrice(row.price) * bounds.height / 360 - 54)}px`;
    };
    svg.onpointerleave = () => { $('chart-tooltip').hidden = true; $('hover-line').setAttribute('visibility', 'hidden'); $('hover-dot').setAttribute('visibility', 'hidden'); };
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
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
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
  $('ticker-search').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); const ticker = $('ticker-search').value.trim().toUpperCase(); if (companies[ticker] && companies[ticker].source !== 'demo') selectTicker(ticker); else loadRealTicker(); } });
  $('load-ticker').addEventListener('click', loadRealTicker);
  document.addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); showView('research'); $('ticker-search').focus(); } });
  document.querySelectorAll('.nav-link').forEach((link) => link.addEventListener('click', (event) => { event.preventDefault(); showView(link.dataset.view); }));
  window.addEventListener('hashchange', () => showView(location.hash.slice(1)));
  $('window-options').addEventListener('click', (event) => { const button = event.target.closest('[data-years]'); if (!button) return; selectedYears = Number(button.dataset.years); $('window-options').querySelectorAll('button').forEach((item) => item.classList.toggle('selected', item === button)); renderResearch(); });
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

  setText('today-label', new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).format(new Date()));
  renderChips(); renderResearch(); renderPortfolio(); showView(location.hash.slice(1) || 'research'); checkApiStatus();
})();
