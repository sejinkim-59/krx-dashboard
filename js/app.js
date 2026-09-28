const grid = document.getElementById('grid');
const overlay = document.getElementById('overlay');
const panelBody = document.getElementById('panelBody');
const closeBtn = document.getElementById('closeBtn');
const lastUpdatedEl = document.getElementById('lastUpdated');
const heroBody = document.getElementById('heroBody');
const heroTime = document.getElementById('heroTime');

function fmtDateStr(s) {
  if (!s || s.length !== 8) return s || '-';
  return `${s.slice(0, 4)}.${s.slice(4, 6)}.${s.slice(6, 8)}`;
}

function pctSpan(v) {
  if (v == null || Number.isNaN(v)) return '<span class="pct flat">-</span>';
  const cls = v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
  const sign = v > 0 ? '+' : '';
  return `<span class="pct ${cls}">${sign}${v}%</span>`;
}

async function fetchJson(file) {
  const res = await fetch(`data/${file}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`데이터 파일을 불러올 수 없습니다: ${file}`);
  return res.json();
}

function renderGrid() {
  grid.innerHTML = '';
  for (const card of CARDS) {
    const el = document.createElement('button');
    el.className = `card status-${card.status}`;
    el.innerHTML = `
      <div class="card-icon">${card.icon}</div>
      <div class="card-title">${card.title}</div>
      <div class="card-desc">${card.desc}</div>
      ${card.status === 'live' ? `<div class="card-preview" data-preview-for="${card.id}"><span class="cp-sub">불러오는 중…</span></div>` : ''}
      <div class="card-footer">
        <span class="tag tag-${card.tag.toLowerCase()}">${card.tag}</span>
        ${card.status === 'pending' ? '<span class="tag tag-pending">준비중</span>' : ''}
      </div>
    `;
    el.addEventListener('click', () => openCard(card));
    grid.appendChild(el);
  }
}

async function openCard(card) {
  overlay.hidden = false;
  panelBody.innerHTML = `<h2>${card.icon} ${card.title}</h2><p class="panel-desc">${card.desc}</p><div class="panel-content">불러오는 중...</div>`;
  const contentEl = panelBody.querySelector('.panel-content');

  if (card.status === 'pending') {
    contentEl.innerHTML = `
      <div class="pending-box">
        <div class="pending-label">⏳ 아직 연결되지 않은 데이터입니다</div>
        <p>${card.reason}</p>
      </div>
    `;
    return;
  }

  try {
    const renderer = window[card.render];
    await renderer(card, contentEl);
  } catch (e) {
    contentEl.innerHTML = `<div class="error-box">데이터를 불러오지 못했습니다: ${e.message}</div>`;
  }
}

function closeOverlay() {
  overlay.hidden = true;
  panelBody.innerHTML = '';
}
closeBtn.addEventListener('click', closeOverlay);
overlay.addEventListener('click', (e) => {
  if (e.target === overlay) closeOverlay();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeOverlay();
});

// ---------------- 헤더 히어로: 클릭 없이 바로 보이는 시장 요약 ----------------

async function loadHero() {
  try {
    const data = await fetchJson('us-market-brief.json');
    heroTime.textContent = new Date(data.updated_at).toLocaleString('ko-KR');
    let html = `<p class="hero-summary">${data.summary}</p><div class="hero-tiles">`;
    for (const r of data.instruments) {
      const cls = r.change_pct > 0 ? 'up' : r.change_pct < 0 ? 'down' : 'flat';
      const sign = r.change_pct > 0 ? '+' : '';
      html += `
        <div class="stat-tile">
          <span class="label">${r.label}</span>
          <span class="value">${r.last != null ? Number(r.last).toLocaleString(undefined, { maximumFractionDigits: 2 }) : '-'}</span>
          <span class="delta ${cls}">${r.change_pct != null ? `${sign}${r.change_pct}%` : '-'}</span>
        </div>`;
    }
    html += '</div>';
    heroBody.innerHTML = html;
  } catch (e) {
    heroBody.innerHTML = `<p class="hero-empty">시장 요약을 아직 불러올 수 없습니다.</p>`;
  }
}

// ---------------- 그리드 타일 미리보기 (클릭 전에 한눈에) ----------------

async function loadCardPreviews() {
  const liveCards = CARDS.filter((c) => c.status === 'live');
  await Promise.all(liveCards.map(async (card) => {
    const slot = grid.querySelector(`[data-preview-for="${card.id}"]`);
    if (!slot) return;
    try {
      const html = await buildPreview(card);
      slot.innerHTML = html ?? '<span class="cp-sub">-</span>';
    } catch {
      slot.innerHTML = '<span class="cp-sub">불러오기 실패</span>';
    }
  }));
}

async function buildPreview(card) {
  switch (card.id) {
    case 'capital-increase': {
      const [paid, free] = await Promise.all(card.dataFile.map(fetchJson));
      const n = paid.items.length + free.items.length;
      return `<span class="cp-main">${n}건</span><span class="cp-sub">최근 2주</span>`;
    }
    case 'convertible-bond': {
      const d = await fetchJson(card.dataFile);
      return `<span class="cp-main">${d.items.length}건</span><span class="cp-sub">최근 2주</span>`;
    }
    case 'treasury-stock': {
      const d = await fetchJson(card.dataFile);
      const buy = d.items.filter((i) => i.type === '취득').length;
      return `<span class="cp-main">${d.items.length}건</span><span class="cp-sub">취득 ${buy}·처분 ${d.items.length - buy}</span>`;
    }
    case 'insider-plan': {
      const d = await fetchJson(card.dataFile);
      return `<span class="cp-main">${d.items.length}건</span><span class="cp-sub">최근 2주</span>`;
    }
    case 'nvda-earnings': {
      const d = await fetchJson(card.dataFile);
      const nvda = d.symbols.NVDA?.reactions ?? [];
      const latest = nvda[nvda.length - 1];
      if (!latest) return '<span class="cp-sub">데이터 없음</span>';
      const spark = buildSparklineSvg(['D-1', 'D0', 'D+1', 'D+2', 'D+3', 'D+4'].map((k) => latest.reaction[k]).filter((v) => v != null));
      return `${pctSpan(latest.reaction['D+1'])}<span class="cp-sub">최근 실적 D+1 (${latest.earnings_date})</span>${spark}`;
    }
    case 'us-new-highs-20d':
    case 'us-new-highs-50d': {
      const d = await fetchJson(card.dataFile);
      return `<span class="cp-main">${d.count}개</span><span class="cp-sub">신고가 경신</span>`;
    }
    case 'futures-oi': {
      const d = await fetchJson(card.dataFile);
      const top = d.items[0];
      if (!top) return '<span class="cp-sub">데이터 없음</span>';
      return `<span class="cp-main">${top.name}</span><span class="cp-sub">OI ${top.oi.toLocaleString()}</span>`;
    }
    case 'futures-basis': {
      const d = await fetchJson(card.dataFile);
      const top = d.contango[0];
      if (!top) return '<span class="cp-sub">데이터 없음</span>';
      return `${pctSpan(top.basis_pct)}<span class="cp-sub">최대 콘탱고 ${top.name}</span>`;
    }
    case 'us-earnings': {
      const d = await fetchJson(card.dataFile);
      return `<span class="cp-main">${d.count}개</span><span class="cp-sub">최근 실적 발표</span>`;
    }
    case 'kr-earnings': {
      const d = await fetchJson(card.dataFile);
      return `<span class="cp-main">${d.count}개</span><span class="cp-sub">잠정실적 공시</span>`;
    }
    case 'us-market-brief': {
      const d = await fetchJson(card.dataFile);
      const sp = d.instruments.find((i) => i.symbol === '^GSPC');
      return sp ? `${pctSpan(sp.change_pct)}<span class="cp-sub">S&amp;P500</span>` : '';
    }
    default:
      return '';
  }
}

// ---------------- 카드별 렌더러 ----------------

function metaLine(updatedAt) {
  if (!updatedAt) return '';
  const d = new Date(updatedAt);
  return `<div class="meta-line">최종 업데이트: ${d.toLocaleString('ko-KR')}</div>`;
}

function highlightTile(label, value, cls) {
  return `<div class="stat-tile"><span class="label">${label}</span><span class="value ${cls ? `pct ${cls}` : ''}">${value}</span></div>`;
}

async function renderNvdaEarnings(card, el) {
  const data = await fetchJson(card.dataFile);
  let html = metaLine(data.updated_at) + `<p class="note">${data.note}</p>`;
  html += '<div class="small-multiples">';
  const symbolEntries = Object.entries(data.symbols);
  symbolEntries.forEach(([symbol, info], i) => {
    html += `<div class="sm-cell"><h4>${info.label} (${symbol})</h4>`;
    if (!info.reactions.length) {
      html += `<p class="note">데이터 없음${info.error ? ` (${info.error})` : ''}</p></div>`;
      return;
    }
    html += `<div class="chart-box h-160"><canvas id="nvda-chart-${i}"></canvas></div></div>`;
  });
  html += '</div>';
  html += '<table><thead><tr><th>실적일</th><th>D-1</th><th>D0</th><th>D+1</th><th>D+2</th><th>D+3</th><th>D+4</th></tr></thead><tbody>';
  const firstSymbol = symbolEntries[0]?.[1];
  for (const r of firstSymbol?.reactions ?? []) {
    const g = r.reaction;
    html += `<tr><td>${r.earnings_date}</td><td>${pctSpan(g['D-1'])}</td><td>${pctSpan(g.D0)}</td><td>${pctSpan(g['D+1'])}</td><td>${pctSpan(g['D+2'])}</td><td>${pctSpan(g['D+3'])}</td><td>${pctSpan(g['D+4'])}</td></tr>`;
  }
  html += '</tbody></table>';
  html += '<p class="note">아래 표는 첫 번째 계열(NVIDIA) 기준입니다. 다른 종목 수치는 그래프의 툴팁으로 확인하세요.</p>';
  el.innerHTML = html;

  symbolEntries.forEach(([symbol, info], i) => {
    if (!info.reactions.length) return;
    const canvas = document.getElementById(`nvda-chart-${i}`);
    const series = info.reactions.map((r) => ({
      label: r.earnings_date,
      points: ['D-1', 'D0', 'D+1', 'D+2', 'D+3', 'D+4'].map((k) => ({ x: k, y: r.reaction[k] })),
    }));
    makeOrdinalLineChart(canvas, series);
  });
}

async function renderNewHighs(card, el) {
  const data = await fetchJson(card.dataFile);
  let html = metaLine(data.updated_at) + `<p class="note">유니버스: ${data.universe} (${data.universe_size}종목) · ${data.window_days}일 신고가 · 총 ${data.count}개 종목</p>`;
  if (!data.items.length) {
    html += '<p class="note">오늘 신고가 경신 종목이 없습니다.</p>';
    el.innerHTML = html;
    return;
  }
  html += '<div class="chart-box h-lg"><canvas id="newhighs-chart"></canvas></div>';
  html += '<p class="chart-legend-note">상위 15개 (직전 구간 대비 상승률 기준). 빨강=상승 · 파랑=하락.</p>';
  html += '<table><thead><tr><th>티커</th><th>종가</th><th>당일 등락</th><th>직전 구간대비</th></tr></thead><tbody>';
  for (const it of data.items) {
    html += `<tr><td>${it.symbol}</td><td>${it.close?.toFixed ? it.close.toFixed(2) : it.close}</td><td>${pctSpan(it.day_change_pct)}</td><td>${pctSpan(it.pct_above_prior_window)}</td></tr>`;
  }
  html += '</tbody></table>';
  el.innerHTML = html;
  makeDivergingHBar(document.getElementById('newhighs-chart'), data.items, { labelKey: 'symbol', valueKey: 'pct_above_prior_window', maxItems: 15 });
}

async function renderFuturesOi(card, el) {
  const data = await fetchJson(card.dataFile);
  let html = metaLine(data.updated_at) + `<p class="note">${data.note}</p>`;
  html += `<p class="note">기준일: ${fmtDateStr(data.data_date)} (전일: ${fmtDateStr(data.prev_data_date)}) · 미결제약정 상위 ${data.count}종목</p>`;
  html += '<div class="chart-box h-lg"><canvas id="oi-chart"></canvas></div>';
  html += '<p class="chart-legend-note">미결제약정 상위 15종목 (계약 수 기준).</p>';
  html += '<table><thead><tr><th>종목</th><th>상품</th><th>미결제약정</th><th>전일대비</th><th>종가</th></tr></thead><tbody>';
  for (const it of data.items) {
    html += `<tr><td>${it.name}</td><td>${it.product}</td><td>${it.oi.toLocaleString()}</td><td>${it.oi_change == null ? '-' : (it.oi_change > 0 ? '+' : '') + it.oi_change.toLocaleString()}</td><td>${it.close ?? '-'}</td></tr>`;
  }
  html += '</tbody></table>';
  el.innerHTML = html;
  makeMagnitudeHBar(document.getElementById('oi-chart'), data.items, { labelKey: 'name', valueKey: 'oi', maxItems: 15 });
}

async function renderFuturesBasis(card, el) {
  const data = await fetchJson(card.dataFile);
  let html = metaLine(data.updated_at) + `<p class="note">${data.note} · 기준일: ${fmtDateStr(data.data_date)}</p>`;
  const combined = [...data.contango.slice(0, 10), ...data.backwardation.slice(0, 10).reverse()];
  html += '<div class="chart-box h-lg"><canvas id="basis-chart"></canvas></div>';
  html += '<p class="chart-legend-note">콘탱고(빨강, 선물&gt;현물)·백워데이션(파랑, 선물&lt;현물) 상위 10개씩.</p>';
  const table = (items) => {
    let t = '<table><thead><tr><th>종목</th><th>선물가</th><th>현물가</th><th>베이시스</th><th>베이시스%</th></tr></thead><tbody>';
    for (const it of items) {
      t += `<tr><td>${it.name}</td><td>${it.futures_price.toLocaleString()}</td><td>${it.spot_price.toLocaleString()}</td><td>${it.basis.toLocaleString()}</td><td>${pctSpan(it.basis_pct)}</td></tr>`;
    }
    return t + '</tbody></table>';
  };
  html += '<h3>콘탱고 상위 (선물 &gt; 현물)</h3>' + table(data.contango);
  html += '<h3>백워데이션 상위 (선물 &lt; 현물)</h3>' + table(data.backwardation);
  el.innerHTML = html;
  makeDivergingHBar(document.getElementById('basis-chart'), combined, { labelKey: 'name', valueKey: 'basis_pct', maxItems: 20, presorted: true });
}

async function renderUsEarnings(card, el) {
  const data = await fetchJson(card.dataFile);
  let html = metaLine(data.updated_at) + `<p class="note">${data.note}</p>`;
  const withReaction = data.items.filter((it) => it.reaction && it.reaction['D+1'] != null);
  if (withReaction.length) {
    html += '<div class="chart-box h-lg"><canvas id="usearn-chart"></canvas></div>';
    html += '<p class="chart-legend-note">발표 후 첫 거래일(D+1) 반응 기준 상위 종목.</p>';
  }
  html += '<table><thead><tr><th>티커</th><th>발표일</th><th>시간</th><th>서프라이즈</th><th>D-1</th><th>D0</th><th>D+1</th><th>D+2</th><th>D+3</th></tr></thead><tbody>';
  for (const it of data.items) {
    const r = it.reaction || {};
    html += `<tr><td>${it.symbol}</td><td>${it.report_date}</td><td>${it.report_time}</td><td>${it.surprise_pct != null ? pctSpan(it.surprise_pct) : '-'}</td><td>${pctSpan(r['D-1'])}</td><td>${pctSpan(r.D0)}</td><td>${pctSpan(r['D+1'])}</td><td>${pctSpan(r['D+2'])}</td><td>${pctSpan(r['D+3'])}</td></tr>`;
  }
  html += '</tbody></table>';
  el.innerHTML = html;
  if (withReaction.length) {
    makeDivergingHBar(
      document.getElementById('usearn-chart'),
      withReaction.map((it) => ({ symbol: it.symbol, d1: it.reaction['D+1'] })),
      { labelKey: 'symbol', valueKey: 'd1', maxItems: 20 }
    );
  }
}

async function renderKrEarnings(card, el) {
  const data = await fetchJson(card.dataFile);
  let html = metaLine(data.updated_at) + `<p class="note">${data.note}</p>`;
  if (!data.items.length) {
    html += '<p class="note">해당 기간 실적 공시가 없습니다.</p>';
    el.innerHTML = html;
    return;
  }
  const withReaction = data.items.filter((it) => it.reaction && it.reaction['D+1'] != null);
  if (withReaction.length) {
    html += '<div class="chart-box h-220"><canvas id="krearn-chart"></canvas></div>';
    html += '<p class="chart-legend-note">공시 후 첫 거래일(D+1) 반응 기준.</p>';
  }
  html += '<table><thead><tr><th>기업</th><th>공시일</th><th>D-1</th><th>D0</th><th>D+1</th><th>D+2</th><th>D+3</th><th>D+4</th><th>링크</th></tr></thead><tbody>';
  for (const it of data.items) {
    const r = it.reaction || {};
    const link = it.dart_url ? `<a href="${it.dart_url}" target="_blank" rel="noopener">원문</a>` : '-';
    html += `<tr><td>${it.corp_name}</td><td>${fmtDateStr(it.rcept_dt)}</td><td>${pctSpan(r['D-1'])}</td><td>${pctSpan(r.D0)}</td><td>${pctSpan(r['D+1'])}</td><td>${pctSpan(r['D+2'])}</td><td>${pctSpan(r['D+3'])}</td><td>${pctSpan(r['D+4'])}</td><td>${link}</td></tr>`;
  }
  html += '</tbody></table>';
  el.innerHTML = html;
  if (withReaction.length) {
    makeDivergingHBar(
      document.getElementById('krearn-chart'),
      withReaction.map((it) => ({ name: it.corp_name, d1: it.reaction['D+1'] })),
      { labelKey: 'name', valueKey: 'd1', maxItems: 15 }
    );
  }
}

async function renderMarketBrief(card, el) {
  const data = await fetchJson(card.dataFile);
  let html = metaLine(data.updated_at) + `<div class="summary-box">${data.summary}</div>`;
  html += '<div class="highlight-row">';
  for (const r of data.instruments) {
    const cls = r.change_pct > 0 ? 'up' : r.change_pct < 0 ? 'down' : 'flat';
    html += highlightTile(r.label, r.change_pct != null ? `${r.change_pct > 0 ? '+' : ''}${r.change_pct}%` : '-', cls);
  }
  html += '</div>';
  html += '<table><thead><tr><th>지표</th><th>현재값</th><th>등락률</th></tr></thead><tbody>';
  for (const r of data.instruments) {
    html += `<tr><td>${r.label}</td><td>${r.last ?? '-'}</td><td>${pctSpan(r.change_pct)}</td></tr>`;
  }
  html += '</tbody></table>';
  el.innerHTML = html;
}

async function renderCapitalIncrease(card, el) {
  const [paid, free] = await Promise.all(card.dataFile.map(fetchJson));
  let html = metaLine(paid.updated_at);
  html += `<h3>유상증자 (${paid.items.length}건, 최근 ${paid.range.from}~${paid.range.to})</h3>`;
  html += '<p class="note">※ DART API 특성상 배정기준일은 주주배정 방식일 때만 제공됩니다. 제3자배정·일반공모는 원문 링크를 참고하세요.</p>';
  html += renderTable(paid.items, [
    ['corp_name', '종목명'], ['stock_code', '코드'], ['rcept_dt', '접수일', fmtDateStr],
    ['method', '증자방식'], ['new_shares', '신주수'], ['record_date', '배정기준일'],
  ], (row) => `<a href="${row.dart_url}" target="_blank" rel="noopener">원문</a>`);
  html += `<h3>무상증자 (${free.items.length}건)</h3>`;
  html += renderTable(free.items, [
    ['corp_name', '종목명'], ['stock_code', '코드'], ['rcept_dt', '접수일', fmtDateStr],
    ['record_date', '신주배정기준일'], ['ratio_per_share', '1주당 배정'], ['listing_date', '상장예정일'],
  ], (row) => `<a href="${row.dart_url}" target="_blank" rel="noopener">원문</a>`);
  el.innerHTML = html;
}

async function renderConvertibleBond(card, el) {
  const data = await fetchJson(card.dataFile);
  let html = metaLine(data.updated_at) + `<p class="note">최근 ${data.range.from}~${data.range.to} 전환사채 발행결정 공시 ${data.items.length}건</p>`;
  html += renderTable(data.items, [
    ['corp_name', '종목명'], ['stock_code', '코드'], ['rcept_dt', '접수일', fmtDateStr],
    ['conversion_price', '전환가액'], ['conversion_start', '전환청구 시작'], ['conversion_end', '전환청구 종료'], ['maturity_date', '만기일'],
  ], (row) => `<a href="${row.dart_url}" target="_blank" rel="noopener">원문</a>`);
  el.innerHTML = html;
}

async function renderTreasuryStock(card, el) {
  const data = await fetchJson(card.dataFile);
  let html = metaLine(data.updated_at) + `<p class="note">최근 ${data.range.from}~${data.range.to} 자사주 취득/처분 결정 공시 ${data.items.length}건</p>`;
  html += renderTable(data.items, [
    ['corp_name', '종목명'], ['stock_code', '코드'], ['type', '구분'], ['rcept_dt', '접수일', fmtDateStr],
    ['period_start', '기간 시작'], ['period_end', '기간 종료'], ['purpose', '목적'],
  ], (row) => `<a href="${row.dart_url}" target="_blank" rel="noopener">원문</a>`);
  el.innerHTML = html;
}

async function renderInsiderPlan(card, el) {
  const data = await fetchJson(card.dataFile);
  let html = metaLine(data.updated_at) + `<p class="note">최근 ${data.range.from}~${data.range.to} 임원·주요주주 거래계획보고서 ${data.items.length}건</p>`;
  html += renderTable(data.items, [
    ['corp_name', '종목명'], ['stock_code', '코드'], ['flr_nm', '제출인'], ['rcept_dt', '접수일', fmtDateStr],
  ], (row) => `<a href="${row.dart_url}" target="_blank" rel="noopener">DART 원문</a>`);
  el.innerHTML = html;
}

function renderTable(items, columns, extraColRenderer) {
  if (!items || !items.length) return '<p class="note">해당 기간 데이터가 없습니다.</p>';
  let html = '<table><thead><tr>';
  for (const [, label] of columns) html += `<th>${label}</th>`;
  if (extraColRenderer) html += '<th>링크</th>';
  html += '</tr></thead><tbody>';
  for (const row of items) {
    html += '<tr>';
    for (const [key, , fmt] of columns) {
      const v = row[key];
      html += `<td>${v == null ? '-' : fmt ? fmt(v) : v}</td>`;
    }
    if (extraColRenderer) html += `<td>${extraColRenderer(row)}</td>`;
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}

async function updateHeaderMeta() {
  try {
    const meta = await fetchJson('meta.json');
    lastUpdatedEl.textContent = new Date(meta.updated_at).toLocaleString('ko-KR');
  } catch {
    lastUpdatedEl.textContent = '데이터 갱신 대기중';
  }
}

renderGrid();
updateHeaderMeta();
loadHero();
loadCardPreviews();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
