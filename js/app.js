const grid = document.getElementById('grid');
const overlay = document.getElementById('overlay');
const panelBody = document.getElementById('panelBody');
const closeBtn = document.getElementById('closeBtn');
const lastUpdatedEl = document.getElementById('lastUpdated');

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

// ---------------- 카드별 렌더러 ----------------

function metaLine(updatedAt) {
  if (!updatedAt) return '';
  const d = new Date(updatedAt);
  return `<div class="meta-line">최종 업데이트: ${d.toLocaleString('ko-KR')}</div>`;
}

async function renderNvdaEarnings(card, el) {
  const data = await fetchJson(card.dataFile);
  const dates = data.earnings_dates_used;
  let html = metaLine(data.updated_at) + `<p class="note">${data.note}</p>`;
  for (const [symbol, info] of Object.entries(data.symbols)) {
    html += `<h3>${info.label} (${symbol})</h3>`;
    if (!info.reactions.length) {
      html += `<p class="note">데이터 없음${info.error ? ` (${info.error})` : ''}</p>`;
      continue;
    }
    html += '<table><thead><tr><th>실적일</th><th>D-1</th><th>D0</th><th>D+1</th><th>D+2</th><th>D+3</th><th>D+4</th></tr></thead><tbody>';
    for (const r of info.reactions) {
      const g = r.reaction;
      html += `<tr><td>${r.earnings_date}</td><td>${pctSpan(g['D-1'])}</td><td>${pctSpan(g.D0)}</td><td>${pctSpan(g['D+1'])}</td><td>${pctSpan(g['D+2'])}</td><td>${pctSpan(g['D+3'])}</td><td>${pctSpan(g['D+4'])}</td></tr>`;
    }
    html += '</tbody></table>';
  }
  el.innerHTML = html;
}

async function renderNewHighs(card, el) {
  const data = await fetchJson(card.dataFile);
  let html = metaLine(data.updated_at) + `<p class="note">유니버스: ${data.universe} (${data.universe_size}종목) · ${data.window_days}일 신고가 · 총 ${data.count}개 종목</p>`;
  if (!data.items.length) {
    html += '<p class="note">오늘 신고가 경신 종목이 없습니다.</p>';
  } else {
    html += '<table><thead><tr><th>티커</th><th>종가</th><th>당일 등락</th><th>직전 구간대비</th></tr></thead><tbody>';
    for (const it of data.items) {
      html += `<tr><td>${it.symbol}</td><td>${it.close?.toFixed ? it.close.toFixed(2) : it.close}</td><td>${pctSpan(it.day_change_pct)}</td><td>${pctSpan(it.pct_above_prior_window)}</td></tr>`;
    }
    html += '</tbody></table>';
  }
  el.innerHTML = html;
}

async function renderMarketBrief(card, el) {
  const data = await fetchJson(card.dataFile);
  let html = metaLine(data.updated_at) + `<div class="summary-box">${data.summary}</div>`;
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

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
