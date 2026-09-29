// 주식 차트 Workspace. KIS REST 배치 데이터(data/kis-quotes.json, data/kis-ohlcv.json)를 사용하고,
// 이미 존재하는 수급/공매도/DART/실적 데이터를 종목코드(symbol/stock_code)로 매칭해 연결한다.
// 매칭되는 데이터가 없으면 해당 블록을 아예 표시하지 않는다 (지어내지 않음).

async function stockFetchJson(file) {
  const res = await fetch(`data/${file}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`fetch failed: ${file}`);
  return res.json();
}

const STOCK_CACHE = { quotes: null, ohlcv: null };

async function loadKisQuotes() {
  if (!STOCK_CACHE.quotes) {
    try { STOCK_CACHE.quotes = await stockFetchJson('kis-quotes.json'); }
    catch { STOCK_CACHE.quotes = { items: [], updated_at: null, errors: ['load-failed'] }; }
  }
  return STOCK_CACHE.quotes;
}
async function loadKisOhlcv() {
  if (!STOCK_CACHE.ohlcv) {
    try { STOCK_CACHE.ohlcv = await stockFetchJson('kis-ohlcv.json'); }
    catch { STOCK_CACHE.ohlcv = { symbols: {} }; }
  }
  return STOCK_CACHE.ohlcv;
}

let stockCurrentSymbol = null;
let stockCurrentRange = '3M';
let stockCurrentTab = 'overview';
let stockCurrentBars = [];
let stockLastCtx = null;
let stockWorkspaceReady = false;

function statCell(label, value) {
  if (value == null || value === '' || (typeof value === 'number' && Number.isNaN(value))) return '';
  return `<div class="stock-stat"><span class="label">${label}</span><span class="value">${value}</span></div>`;
}

async function initStockWorkspace() {
  if (stockWorkspaceReady) return;
  stockWorkspaceReady = true;

  const input = document.getElementById('stockSearchInput');
  const results = document.getElementById('stockSearchResults');
  const quotesData = await loadKisQuotes();
  const instruments = quotesData.items || [];

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { results.hidden = true; results.innerHTML = ''; return; }
    const matches = instruments.filter((it) => it.symbol.includes(q) || it.name.toLowerCase().includes(q)).slice(0, 8);
    results.innerHTML = matches.length
      ? matches.map((it) => `<button class="stock-search-row" data-symbol="${it.symbol}"><span class="ssr-name">${it.name}</span><span class="ssr-meta">${it.symbol} · ${it.market}</span></button>`).join('')
      : '<div class="stock-search-empty">검색 결과 없음 (현재 관심종목 범위 내에서만 검색됩니다)</div>';
    results.hidden = false;
    results.querySelectorAll('.stock-search-row').forEach((btn) => {
      btn.addEventListener('click', () => {
        input.value = '';
        results.hidden = true;
        selectStock(btn.dataset.symbol);
      });
    });
  });
  document.addEventListener('click', (e) => {
    if (e.target !== input && !results.contains(e.target)) results.hidden = true;
  });

  if (instruments.length) selectStock(instruments[0].symbol);
  else document.getElementById('stockContent').innerHTML = '<p class="note">KIS 시세 데이터를 아직 불러오지 못했습니다.</p>';
}

async function selectStock(symbol) {
  stockCurrentSymbol = symbol;
  stockCurrentRange = '3M';
  stockCurrentTab = 'overview';
  const content = document.getElementById('stockContent');
  content.innerHTML = '<p class="hero-empty">불러오는 중...</p>';

  const quotesData = await loadKisQuotes();
  const inst = quotesData.items.find((i) => i.symbol === symbol);
  if (!inst) {
    content.innerHTML = '<p class="note">이 종목은 현재 관심종목 목록에 없어 KIS 데이터를 아직 수집하지 않았습니다.</p>';
    return;
  }
  renderStockContent(inst, quotesData.updated_at);

  const ohlcvData = await loadKisOhlcv();
  stockCurrentBars = ohlcvData.symbols[symbol] || [];
  renderChartForRange();

  const ctx = await buildStockContext(symbol, inst.name);
  stockLastCtx = ctx;
  renderContextColumn(ctx);
  renderStockTabs(ctx);
}

function renderStockContent(inst, updatedAt) {
  const content = document.getElementById('stockContent');
  const cls = inst.change > 0 ? 'up' : inst.change < 0 ? 'down' : 'flat';
  const sign = inst.change > 0 ? '+' : '';
  const time = updatedAt ? new Date(updatedAt).toLocaleTimeString('ko-KR') : '-';

  content.innerHTML = `
    <div class="stock-header">
      <div class="stock-header-main">
        <div class="stock-name">${inst.name}</div>
        <div class="stock-code">${inst.symbol} · ${inst.market}</div>
      </div>
      <div class="stock-price-block">
        <div class="stock-price ${cls}">${inst.price != null ? inst.price.toLocaleString() : '-'}</div>
        <div class="stock-change ${cls}">${inst.change != null ? `${sign}${inst.change.toLocaleString()} (${sign}${inst.changePercent}%)` : '-'}</div>
      </div>
      <div class="stock-updated">최근 조회 ${time}</div>
    </div>
    <div class="stock-stats-row">
      ${statCell('시가', inst.open?.toLocaleString())}
      ${statCell('고가', inst.high?.toLocaleString())}
      ${statCell('저가', inst.low?.toLocaleString())}
      ${statCell('전일종가', inst.previousClose?.toLocaleString())}
      ${statCell('거래량', inst.volume?.toLocaleString())}
      ${statCell('거래대금', inst.tradingValue != null ? formatWonCompact(inst.tradingValue) : null)}
      ${statCell('시가총액', inst.marketCap != null ? `${(inst.marketCap / 10000).toFixed(1)}조` : null)}
      ${statCell('52주 최고', inst.week52High?.toLocaleString())}
      ${statCell('52주 최저', inst.week52Low?.toLocaleString())}
      ${statCell('PER', inst.per)}
      ${statCell('PBR', inst.pbr)}
    </div>
    <div class="stock-body">
      <div class="stock-chart-col">
        <div class="chart-range-tabs" id="chartRangeTabs">
          <button data-range="1M">1개월</button>
          <button data-range="3M" class="active">3개월</button>
          <button data-range="ALL">전체</button>
        </div>
        <div id="stockChartContainer" class="stock-chart-container"></div>
        <div class="stock-tabs" id="stockTabs">
          <button data-tab="overview" class="active">Overview</button>
          <button data-tab="flow">수급</button>
          <button data-tab="short">공매도</button>
          <button data-tab="filing">공시</button>
          <button data-tab="events">이벤트</button>
        </div>
        <div id="stockTabContent" class="stock-tab-content"></div>
      </div>
      <div class="stock-context-col" id="stockContextCol"><p class="hero-empty">연관 데이터 확인 중...</p></div>
    </div>
  `;

  content.querySelectorAll('#chartRangeTabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      content.querySelectorAll('#chartRangeTabs button').forEach((b) => b.classList.toggle('active', b === btn));
      stockCurrentRange = btn.dataset.range;
      renderChartForRange();
    });
  });
  content.querySelectorAll('#stockTabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      content.querySelectorAll('#stockTabs button').forEach((b) => b.classList.toggle('active', b === btn));
      stockCurrentTab = btn.dataset.tab;
      renderStockTabs(stockLastCtx);
    });
  });
}

function renderChartForRange() {
  const container = document.getElementById('stockChartContainer');
  if (!container) return;
  let bars = stockCurrentBars;
  if (stockCurrentRange === '1M') bars = bars.slice(-22);
  else if (stockCurrentRange === '3M') bars = bars.slice(-65);
  renderCandlestickChart(container, bars);
}

/** 이미 수집된 데이터에서 종목코드/이름이 일치하는 것만 골라 연결한다. */
async function buildStockContext(symbol, name) {
  const files = [
    'investor-flow.json', 'short-selling.json', 'market-alerts.json',
    'dart-capital-increase-paid.json', 'dart-capital-increase-free.json',
    'dart-convertible-bond.json', 'dart-treasury-stock.json', 'dart-insider-plan.json',
    'kr-earnings-reaction.json',
  ];
  const results = await Promise.allSettled(files.map(stockFetchJson));
  const [flow, short, alerts, paid, free, cb, treasury, insider, krEarn] = results.map((r) => (r.status === 'fulfilled' ? r.value : null));

  const ctx = { flowFlip: null, shortItem: null, filings: [], alerts: [], earnings: null };

  if (flow) {
    for (const inv of Object.values(flow.investors || {})) {
      const f = (inv.flips || []).find((x) => x.symbol === symbol);
      if (f) { ctx.flowFlip = { ...f, investor: inv.label }; break; }
    }
  }
  if (short) ctx.shortItem = (short.items || []).find((x) => x.symbol === symbol) || null;
  if (alerts) {
    for (const cat of Object.values(alerts.categories || {})) {
      for (const it of cat.items || []) if (it.corp_name === name) ctx.alerts.push({ ...it, catLabel: cat.label });
    }
  }

  const dartSets = [
    { data: paid, label: '유상증자', cardId: 'capital-increase' },
    { data: free, label: '무상증자', cardId: 'capital-increase' },
    { data: cb, label: '전환사채', cardId: 'convertible-bond' },
    { data: treasury, label: '자사주', cardId: 'treasury-stock' },
    { data: insider, label: '내부자 거래계획', cardId: 'insider-plan' },
  ];
  for (const set of dartSets) {
    if (!set.data) continue;
    for (const it of set.data.items || []) {
      if (it.stock_code === symbol) ctx.filings.push({ ...it, filingType: set.label, cardId: set.cardId });
    }
  }
  ctx.filings.sort((a, b) => (b.rcept_dt || '').localeCompare(a.rcept_dt || ''));

  if (krEarn) ctx.earnings = (krEarn.items || []).find((x) => x.stock_code === symbol) || null;

  return ctx;
}

function ctxBlock(label, bodyHtml, jumpCardId) {
  return `<div class="ctx-block"${jumpCardId ? ` data-jump="${jumpCardId}"` : ''}>
    <div class="ctx-label">${label}</div>
    ${bodyHtml}
  </div>`;
}

function renderContextColumn(ctx) {
  const blocks = [];
  if (ctx.flowFlip) {
    const toBuy = ctx.flowFlip.recent_net > 0;
    blocks.push(ctxBlock('TODAY · FLOW REVERSAL',
      `<p>${ctx.flowFlip.investor} 수급 ${toBuy ? '매도 → 매수' : '매수 → 매도'} 전환</p><p class="ctx-metric ${toBuy ? 'up' : 'down'}">${formatWonCompact(ctx.flowFlip.swing)}</p>`,
      'investor-flow'));
  }
  if (ctx.filings[0]) {
    const f = ctx.filings[0];
    blocks.push(ctxBlock('RECENT FILING', `<p>${f.filingType} 공시</p><p class="ctx-date">${fmtDateStr(f.rcept_dt)}</p>`, f.cardId));
  }
  if (ctx.shortItem) {
    blocks.push(ctxBlock('SHORT SELLING', `<p class="ctx-metric">${ctx.shortItem.short_ratio_pct}%</p><p>거래대금 상위 유니버스 내 공매도 비중</p>`, 'short-selling'));
  }
  if (ctx.earnings) {
    const d1 = ctx.earnings.reaction?.['D+1'];
    blocks.push(ctxBlock('EARNINGS', `<p>실적 공시 ${fmtDateStr(ctx.earnings.rcept_dt)}</p>${d1 != null ? `<p>D+1 반응 ${pctSpan(d1)}</p>` : ''}`, 'kr-earnings'));
  }
  const col = document.getElementById('stockContextCol');
  if (!col) return;
  col.innerHTML = blocks.length ? blocks.join('') : '<p class="hero-empty">이 종목과 연결된 시그널·공시가 현재 없습니다.</p>';
  col.querySelectorAll('[data-jump]').forEach((el) => {
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => {
      const card = CARDS.find((c) => c.id === el.dataset.jump);
      if (card) openCard(card);
    });
  });
}

function renderStockTabs(ctx) {
  const wrap = document.getElementById('stockTabContent');
  if (!wrap || !ctx) return;
  const panels = {
    overview: '<p class="note">차트와 오른쪽 패널에서 핵심 정보를 확인하세요. 세부 내역은 각 탭에서 볼 수 있습니다.</p>',
    flow: ctx.flowFlip
      ? `<p>${ctx.flowFlip.investor} 최근 3거래일 순매수 ${formatWonCompact(ctx.flowFlip.recent_net)} · 직전 5거래일 ${formatWonCompact(ctx.flowFlip.prior_net)}</p>`
      : '<p class="note">이 종목의 수급 전환 데이터가 없습니다.</p>',
    short: ctx.shortItem
      ? `<table><thead><tr><th>시장</th><th>공매도 비중</th><th>공매도대금</th><th>총거래대금</th></tr></thead><tbody><tr><td>${ctx.shortItem.market}</td><td>${ctx.shortItem.short_ratio_pct}%</td><td>${ctx.shortItem.short_sell_value.toLocaleString()}</td><td>${ctx.shortItem.total_trade_value.toLocaleString()}</td></tr></tbody></table>`
      : '<p class="note">이 종목은 공매도 상위 유니버스에 없습니다.</p>',
    filing: ctx.filings.length
      ? `<table><thead><tr><th>유형</th><th>접수일</th><th>링크</th></tr></thead><tbody>${ctx.filings.map((f) => `<tr><td>${f.filingType}</td><td>${fmtDateStr(f.rcept_dt)}</td><td>${f.dart_url ? `<a href="${f.dart_url}" target="_blank" rel="noopener">원문</a>` : '-'}</td></tr>`).join('')}</tbody></table>`
      : '<p class="note">최근 2주 내 관련 공시가 없습니다.</p>',
    events: (() => {
      const rows = [];
      if (ctx.earnings) rows.push(`실적 공시 접수일 ${fmtDateStr(ctx.earnings.rcept_dt)}${ctx.earnings.reaction?.['D+1'] != null ? ` · D+1 반응 ${pctSpan(ctx.earnings.reaction['D+1'])}` : ''}`);
      for (const a of ctx.alerts) rows.push(`${a.catLabel} 지정 (${a.designated_date})`);
      return rows.length ? rows.map((r) => `<p>${r}</p>`).join('') : '<p class="note">예정된 이벤트 데이터가 없습니다.</p>';
    })(),
  };
  wrap.innerHTML = panels[stockCurrentTab] || '';
}
