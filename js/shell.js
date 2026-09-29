// Sidebar + Workspace 전환 셸. 각 view는 처음 열릴 때만 지연 로드한다.

const SIDEBAR_VIEWS = ['home', 'stock', 'signals-full', 'screener', 'events', 'watchlist', 'datahub', 'ai-analyst'];

function switchView(view) {
  document.querySelectorAll('.sidebar-item[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  SIDEBAR_VIEWS.forEach((v) => {
    const el = document.getElementById(`view-${v}`);
    if (el) el.hidden = v !== view;
  });
  if (view === 'stock') initStockWorkspace();
  else if (view === 'signals-full') loadSignalsFullFeed();
  else if (view === 'screener') renderCategoriesInto(document.getElementById('screenerBody'), ['flow', 'derivatives', 'etf', 'macro']);
  else if (view === 'events') renderCategoriesInto(document.getElementById('eventsBody'), ['corporate']);
  else if (view === 'datahub') loadDataHub();
}

function initShell() {
  document.querySelectorAll('.sidebar-item[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
}

async function loadSignalsFullFeed() {
  const body = document.getElementById('signalsFullBody');
  body.innerHTML = '<p class="hero-empty">불러오는 중...</p>';
  const results = await Promise.allSettled(SIGNAL_DETECTORS.map((fn) => fn()));
  const list = results.filter((r) => r.status === 'fulfilled' && r.value).map((r) => r.value).sort((a, b) => b.severity - a.severity);
  if (!list.length) {
    body.innerHTML = '<p class="hero-empty">현재 임계값을 넘는 시그널이 감지되지 않았습니다.</p>';
    return;
  }
  body.innerHTML = `<div class="feed-list">${list.map((s) => `
    <button class="feed-row" data-card-id="${s.cardId}" title="${s.reason}">
      <span class="feed-type">${s.type}</span>
      <span class="feed-entity">${s.entity}</span>
      <span class="feed-line">${s.line}</span>
      <span class="feed-metric ${toneClass(s.metricCls)}">${s.metric}</span>
    </button>`).join('')}</div>`;
  body.querySelectorAll('[data-card-id]').forEach((el) => {
    el.addEventListener('click', () => {
      const card = CARDS.find((c) => c.id === el.dataset.cardId);
      if (card) openCard(card);
    });
  });
}

async function dataSourceRow(label, file) {
  try {
    const d = await stockFetchJson(file);
    if (d && d.updated_at) return { label, status: 'Connected', time: new Date(d.updated_at).toLocaleString('ko-KR') };
    return { label, status: 'Error', time: '-' };
  } catch {
    return { label, status: 'Error', time: '-' };
  }
}

async function loadDataHub() {
  const body = document.getElementById('datahubBody');
  body.innerHTML = '<p class="hero-empty">확인 중...</p>';
  const rows = await Promise.all([
    dataSourceRow('KIS REST · 국내주식 시세', 'kis-quotes.json'),
    dataSourceRow('DART 전자공시', 'dart-capital-increase-paid.json'),
    dataSourceRow('KRX 공매도', 'short-selling.json'),
    dataSourceRow('KRX 수급 · 투자경보', 'investor-flow.json'),
    dataSourceRow('KRX 파생상품', 'krx-futures-oi.json'),
    dataSourceRow('미국 시장 (Yahoo/Nasdaq)', 'us-market-brief.json'),
  ]);
  body.innerHTML = `
    <div class="datahub-list">${rows.map((r) => `
      <div class="datahub-row">
        <span class="dh-label">${r.label}</span>
        <span class="dh-status status-${r.status.toLowerCase()}">${r.status}</span>
        <span class="dh-time">${r.time}</span>
      </div>`).join('')}
    </div>
    <p class="note" style="margin-top:14px">KIS 데이터는 30분 주기 배치로 갱신됩니다 (실시간 WebSocket이 아닙니다). APP KEY·SECRET·Access Token 값은 이 화면을 포함해 어디에도 표시되지 않습니다.</p>
  `;
}
