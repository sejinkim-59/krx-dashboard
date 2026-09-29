const grid = document.getElementById('grid');
const overlay = document.getElementById('overlay');
const panelBody = document.getElementById('panelBody');
const closeBtn = document.getElementById('closeBtn');
const lastUpdatedEl = document.getElementById('lastUpdated');
const ticker = document.getElementById('ticker');

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

const ZONES = [
  { id: 'primary', className: 'zone-primary' },
  { id: 'secondary', className: 'zone-secondary' },
  { id: 'tertiary', className: 'zone-tertiary' },
];

function renderGrid() {
  grid.innerHTML = '';
  const byCategory = new Map(CATEGORIES.map((c) => [c.id, []]));
  for (const card of CARDS) (byCategory.get(card.category) || []).push(card);

  ZONES.forEach((zone) => {
    const cats = CATEGORIES.filter((c) => c.zone === zone.id);
    if (!cats.length) return;
    const col = document.createElement('div');
    col.className = `terminal-zone ${zone.className}`;
    cats.forEach((cat) => {
      const cards = byCategory.get(cat.id);
      if (!cards || !cards.length) return;
      const section = document.createElement('section');
      section.className = 'scan-section';
      section.innerHTML = `
        <div class="scan-section-head">
          <h2>${cat.label}</h2>
          <p class="panel-context">${cat.blurb}</p>
        </div>
        <div class="scan-rows"></div>
      `;
      const inner = section.querySelector('.scan-rows');
      cards.forEach((card) => {
        const el = document.createElement('button');
        el.className = `scan-row status-${card.status}`;
        el.innerHTML = `
          <span class="scan-main">
            <span class="scan-title">${card.title}</span>
            <span class="scan-desc">${card.desc}</span>
          </span>
          <span class="scan-metric" data-preview-for="${card.id}">
            ${card.status === 'live' ? '<span class="cp-sub">불러오는 중…</span>' : '<span class="cp-sub">데이터 연결 대기</span>'}
          </span>
        `;
        el.addEventListener('click', () => openCard(card));
        inner.appendChild(el);
      });
      col.appendChild(section);
    });
    grid.appendChild(col);
  });
}

async function openCard(card) {
  overlay.hidden = false;
  const cat = CATEGORIES.find((c) => c.id === card.category) || { label: '' };
  const dateStr = new Date().toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
  const hasToggle = VIEW_TOGGLE_CARDS.has(card.id) && card.status === 'live';
  panelBody.innerHTML = `
    <div class="panel-head">
      <span class="panel-head-icon">${iconSvg(card.icon, 17)}</span>
      <div class="panel-head-text">
        <div class="panel-head-title">${card.title}</div>
        <div class="panel-head-sub">${cat.label} · ${card.tag}${card.status === 'pending' ? ' · 대기' : ''}</div>
      </div>
      ${hasToggle ? `<div class="view-toggle" role="tablist">
        <button class="view-toggle-btn active" data-mode="invest">투자</button>
        <button class="view-toggle-btn" data-mode="biz">업무</button>
      </div>` : ''}
      <div class="panel-head-date">${dateStr}</div>
    </div>
    <div class="panel-body-inner"><div class="panel-content">불러오는 중...</div></div>
  `;
  const contentEl = panelBody.querySelector('.panel-content');

  if (card.status === 'pending') {
    contentEl.innerHTML = `
      ${usageBox(card.usage)}
      <div class="pending-box">
        <div class="pending-label">아직 연결되지 않은 데이터입니다</div>
        <p>${card.reason}</p>
      </div>
    `;
    return;
  }

  const renderer = window[card.render];
  const run = async (mode) => {
    try {
      await renderer(card, contentEl, mode);
    } catch (e) {
      contentEl.innerHTML = `<div class="error-box">데이터를 불러오지 못했습니다: ${e.message}</div>`;
    }
  };

  if (hasToggle) {
    panelBody.querySelectorAll('.view-toggle-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        panelBody.querySelectorAll('.view-toggle-btn').forEach((b) => b.classList.toggle('active', b === btn));
        run(btn.dataset.mode);
      });
    });
  }

  await run('invest');
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
    let tHtml = '';
    for (const r of data.instruments) {
      const cls = r.change_pct > 0 ? 'up' : r.change_pct < 0 ? 'down' : 'flat';
      const sign = r.change_pct > 0 ? '+' : '';
      tHtml += `
        <div class="ticker-item">
          <span class="t-label">${r.label}</span>
          <span class="t-row">
            <span class="t-value">${r.last != null ? Number(r.last).toLocaleString(undefined, { maximumFractionDigits: 2 }) : '-'}</span>
            <span class="t-delta ${cls}">${r.change_pct != null ? `${sign}${r.change_pct}%` : '-'}</span>
          </span>
        </div>`;
    }
    ticker.innerHTML = tHtml;
  } catch (e) {
    ticker.innerHTML = '<div class="ticker-item"><span class="t-label hero-empty">시장 데이터를 불러올 수 없습니다.</span></div>';
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
      return `<span class="cp-main">${d.items.length}건</span><span class="cp-sub">취득 <b class="cp-emph">${buy}</b> · 처분 <b class="cp-emph">${d.items.length - buy}</b></span>`;
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
      return `<span class="cp-main">${top.name}</span><span class="cp-sub">OI <b class="cp-emph">${top.oi.toLocaleString()}</b></span>`;
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
    case 'etf-rebalance-schedule': {
      const d = await fetchJson(card.dataFile);
      const next = d.indices[0];
      return `<span class="cp-main">${next.next_occurrence}</span><span class="cp-sub">${next.name} 다음 변경</span>`;
    }
    case 'sector-etf-rebalance': {
      const d = await fetchJson(card.dataFile);
      if (!d.has_baseline) return '<span class="cp-sub">첫 스냅샷 수집됨</span>';
      return `<span class="cp-main">${d.changed_etf_count}개</span><span class="cp-sub">ETF 변화 감지</span>`;
    }
    case 'short-selling': {
      const d = await fetchJson(card.dataFile);
      const top = d.items[0];
      if (!top) return '<span class="cp-sub">데이터 없음</span>';
      return `<span class="cp-main">${top.name}</span><span class="cp-sub">공매도 비중 <b class="cp-emph">${top.short_ratio_pct}%</b></span>`;
    }
    case 'alert-screener': {
      const d = await fetchJson(card.dataFile);
      const total = Object.values(d.categories).reduce((s, c) => s + c.count, 0);
      return `<span class="cp-main">${total}건</span><span class="cp-sub">최근 2주 지정</span>`;
    }
    case 'investor-flow': {
      const d = await fetchJson(card.dataFile);
      const foreign = d.investors['9000'];
      const top = foreign?.top_net_buy?.[0];
      if (!top) return '<span class="cp-sub">데이터 없음</span>';
      return `<span class="cp-main">${top.name}</span><span class="cp-sub">외국인 순매수 1위 · <b class="cp-emph">${formatWonCompact(top.net)}</b></span>`;
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

/** 투자/업무 View Toggle이 있는 카드에서 모드에 따라 다른 강조 콘텐츠를 보여준다. */
function viewNote(mode, investHtml, bizHtml) {
  return `<div class="view-note">${mode === 'biz' ? bizHtml : investHtml}</div>`;
}

const VIEW_TOGGLE_CARDS = new Set(['capital-increase', 'convertible-bond']);

async function renderNvdaEarnings(card, el) {
  const data = await fetchJson(card.dataFile);
  const insights = INSIGHT_BUILDERS[card.id]?.(data) || [];
  let html = renderHeadlineCallout(card, insights) + usageBox(card.usage) + renderBulletSection(insights.slice(1)) + metaLine(data.updated_at) + `<p class="note">${data.note}</p>`;
  const nvdaReactions = data.symbols?.NVDA?.reactions;
  const latestNvda = nvdaReactions?.[nvdaReactions.length - 1];
  if (latestNvda) {
    html += renderKeyMetrics([
      { label: '실적일', value: latestNvda.earnings_date },
      { label: 'D0', value: pctSpan(latestNvda.reaction.D0) },
      { label: 'D+1', value: pctSpan(latestNvda.reaction['D+1']) },
      { label: 'D+3', value: pctSpan(latestNvda.reaction['D+3']) },
    ]);
  }
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
  const insights = INSIGHT_BUILDERS[card.id]?.(data) || [];
  let html = renderHeadlineCallout(card, insights) + usageBox(card.usage) + renderBulletSection(insights.slice(1)) + metaLine(data.updated_at) + `<p class="note">유니버스: ${data.universe} (${data.universe_size}종목) · ${data.window_days}일 신고가 · 총 ${data.count}개 종목</p>`;
  if (!data.items.length) {
    html += '<p class="note">오늘 신고가 경신 종목이 없습니다.</p>';
    el.innerHTML = html;
    return;
  }
  html += renderKeyMetrics([
    { label: '신고가 종목수', value: `${data.count}개` },
    { label: '유니버스 대비', value: `${((data.count / data.universe_size) * 100).toFixed(1)}%` },
    { label: '최고 상승', value: `${data.items[0].symbol} ${pctSpan(data.items[0].pct_above_prior_window)}` },
  ]);
  html += '<p class="chart-legend-note">상위 15개 (직전 구간 대비 상승률 기준).</p>';
  html += renderRankBars(data.items, { labelKey: 'symbol', valueKey: 'pct_above_prior_window', fmt: (v) => `${v > 0 ? '+' : ''}${v}%`, maxItems: 15 });
  html += '<table><thead><tr><th>티커</th><th>종가</th><th>당일 등락</th><th>직전 구간대비</th></tr></thead><tbody>';
  for (const it of data.items) {
    html += `<tr><td>${it.symbol}</td><td>${it.close?.toFixed ? it.close.toFixed(2) : it.close}</td><td>${pctSpan(it.day_change_pct)}</td><td>${pctSpan(it.pct_above_prior_window)}</td></tr>`;
  }
  html += '</tbody></table>';
  el.innerHTML = html;
}

async function renderFuturesOi(card, el) {
  const data = await fetchJson(card.dataFile);
  const insights = INSIGHT_BUILDERS[card.id]?.(data) || [];
  let html = renderHeadlineCallout(card, insights) + usageBox(card.usage) + renderBulletSection(insights.slice(1)) + metaLine(data.updated_at) + `<p class="note">${data.note}</p>`;
  html += `<p class="note">기준일: ${fmtDateStr(data.data_date)} (전일: ${fmtDateStr(data.prev_data_date)}) · 미결제약정 상위 ${data.count}종목</p>`;
  const oiGainer = [...data.items].sort((a, b) => (b.oi_change ?? -Infinity) - (a.oi_change ?? -Infinity))[0];
  const oiLoser = [...data.items].sort((a, b) => (a.oi_change ?? Infinity) - (b.oi_change ?? Infinity))[0];
  html += renderKeyMetrics([
    { label: '최대 증가', value: oiGainer ? `${oiGainer.name} +${(oiGainer.oi_change ?? 0).toLocaleString()}` : null },
    { label: '최대 감소', value: oiLoser ? `${oiLoser.name} ${(oiLoser.oi_change ?? 0).toLocaleString()}` : null },
    { label: '1위 잔량', value: data.items[0] ? `${data.items[0].name} ${data.items[0].oi.toLocaleString()}계약` : null },
  ]);
  html += renderRankBars(data.items, { labelKey: 'name', valueKey: 'oi', fmt: (v) => v.toLocaleString(), colorMode: 'neutral', maxItems: 15 });
  html += '<table><thead><tr><th>종목</th><th>상품</th><th>미결제약정</th><th>전일대비</th><th>종가</th></tr></thead><tbody>';
  for (const it of data.items) {
    html += `<tr><td>${it.name}</td><td>${it.product}</td><td>${it.oi.toLocaleString()}</td><td>${it.oi_change == null ? '-' : (it.oi_change > 0 ? '+' : '') + it.oi_change.toLocaleString()}</td><td>${it.close ?? '-'}</td></tr>`;
  }
  html += '</tbody></table>';
  el.innerHTML = html;
}

async function renderFuturesBasis(card, el) {
  const data = await fetchJson(card.dataFile);
  const insights = INSIGHT_BUILDERS[card.id]?.(data) || [];
  let html = renderHeadlineCallout(card, insights) + usageBox(card.usage) + renderBulletSection(insights.slice(1)) + metaLine(data.updated_at) + `<p class="note">${data.note} · 기준일: ${fmtDateStr(data.data_date)}</p>`;
  html += renderKeyMetrics([
    { label: '최대 콘탱고', value: data.contango[0] ? `${data.contango[0].name} +${data.contango[0].basis_pct}%` : null },
    { label: '최대 백워데이션', value: data.backwardation[0] ? `${data.backwardation[0].name} ${data.backwardation[0].basis_pct}%` : null },
  ]);
  const rankFmt = (v) => `${v > 0 ? '+' : ''}${v}%`;
  const table = (items) => {
    let t = '<table><thead><tr><th>종목</th><th>선물가</th><th>현물가</th><th>베이시스</th><th>베이시스%</th></tr></thead><tbody>';
    for (const it of items) {
      t += `<tr><td>${it.name}</td><td>${it.futures_price.toLocaleString()}</td><td>${it.spot_price.toLocaleString()}</td><td>${it.basis.toLocaleString()}</td><td>${pctSpan(it.basis_pct)}</td></tr>`;
    }
    return t + '</tbody></table>';
  };
  html += '<h3>콘탱고 상위 (선물 &gt; 현물)</h3>' + renderRankBars(data.contango, { labelKey: 'name', valueKey: 'basis_pct', fmt: rankFmt, maxItems: 10, presorted: true }) + table(data.contango);
  html += '<h3>백워데이션 상위 (선물 &lt; 현물)</h3>' + renderRankBars(data.backwardation, { labelKey: 'name', valueKey: 'basis_pct', fmt: rankFmt, maxItems: 10, presorted: true }) + table(data.backwardation);
  el.innerHTML = html;
}

async function renderIndexCalendar(card, el) {
  const data = await fetchJson(card.dataFile);
  const insights = INSIGHT_BUILDERS[card.id]?.(data) || [];
  let html = renderHeadlineCallout(card, insights) + usageBox(card.usage) + renderBulletSection(insights.slice(1)) + metaLine(data.updated_at) + `<p class="note">${data.note}</p>`;
  html += '<table><thead><tr><th>지수</th><th>산출기관</th><th>주기</th><th>다음 예정</th><th>비고</th></tr></thead><tbody>';
  for (const idx of data.indices) {
    html += `<tr><td>${idx.name}</td><td>${idx.manager}</td><td>${idx.frequency}</td><td>${idx.next_occurrence}</td><td>${idx.note || '-'}</td></tr>`;
  }
  html += '</tbody></table>';
  el.innerHTML = html;
}

async function renderEtfRebalance(card, el) {
  const data = await fetchJson(card.dataFile);
  const insights = INSIGHT_BUILDERS[card.id]?.(data) || [];
  let html = renderHeadlineCallout(card, insights) + usageBox(card.usage) + renderBulletSection(insights.slice(1)) + metaLine(data.updated_at) + `<p class="note">${data.note}</p>`;
  if (!data.has_baseline) {
    html += '<div class="pending-box"><div class="pending-label">첫 스냅샷 수집 완료</div><p>다음 실행부터 전일 대비 변화가 감지됩니다.</p></div>';
    el.innerHTML = html;
    return;
  }
  if (!data.items.length) {
    html += `<p class="note">유니버스 ${data.universe_size}개 ETF 중 변화가 감지된 종목이 없습니다.</p>`;
    el.innerHTML = html;
    return;
  }
  for (const etf of data.items) {
    html += `<h3>${etf.name} (${etf.trd_dt})</h3>`;
    if (etf.added.length) html += `<p class="note"><span class="pct up">▲</span> 신규 편입: ${etf.added.map((a) => a.name).join(', ')}</p>`;
    if (etf.removed.length) html += `<p class="note"><span class="pct down">▼</span> 편출: ${etf.removed.map((r) => r.name).join(', ')}</p>`;
    if (etf.changed.length) {
      html += '<table><thead><tr><th>종목</th><th>이전 비중</th><th>현재 비중</th><th>변화</th></tr></thead><tbody>';
      for (const c of etf.changed) {
        html += `<tr><td>${c.name}</td><td>${c.prev_weight}%</td><td>${c.curr_weight}%</td><td>${pctSpan(c.delta)}</td></tr>`;
      }
      html += '</tbody></table>';
    }
  }
  el.innerHTML = html;
}

async function renderShortSelling(card, el) {
  const data = await fetchJson(card.dataFile);
  const insights = INSIGHT_BUILDERS[card.id]?.(data) || [];
  let html = renderHeadlineCallout(card, insights) + usageBox(card.usage) + renderBulletSection(insights.slice(1)) + metaLine(data.updated_at) + `<p class="note">${data.note}</p>`;
  html += `<p class="note">기준일: ${data.trade_date} · 유니버스 ${data.universe_size}종목</p>`;
  if (!data.items.length) {
    html += '<p class="note">데이터가 없습니다.</p>';
    el.innerHTML = html;
    return;
  }
  const heavyCount = data.items.filter((it) => it.short_ratio_pct >= 20).length;
  html += renderKeyMetrics([
    { label: '비중 1위', value: `${data.items[0].name} ${data.items[0].short_ratio_pct}%` },
    { label: '20% 이상 종목', value: `${heavyCount}개` },
    { label: '유니버스', value: `${data.universe_size}종목` },
  ]);
  html += '<p class="chart-legend-note">당일 공매도 거래대금 비중 상위 15종목.</p>';
  html += renderRankBars(data.items, { labelKey: 'name', valueKey: 'short_ratio_pct', fmt: (v) => `${v}%`, colorMode: 'neutral', maxItems: 15 });
  html += '<table><thead><tr><th>종목</th><th>시장</th><th>공매도 비중</th><th>공매도대금</th><th>총거래대금</th></tr></thead><tbody>';
  for (const it of data.items) {
    html += `<tr><td>${it.name}</td><td>${it.market}</td><td>${pctSpan(it.short_ratio_pct)}</td><td>${it.short_sell_value.toLocaleString()}</td><td>${it.total_trade_value.toLocaleString()}</td></tr>`;
  }
  html += '</tbody></table>';
  el.innerHTML = html;
}

async function renderMarketAlerts(card, el) {
  const data = await fetchJson(card.dataFile);
  const insights = INSIGHT_BUILDERS[card.id]?.(data) || [];
  let html = renderHeadlineCallout(card, insights) + usageBox(card.usage) + renderBulletSection(insights.slice(1)) + metaLine(data.updated_at) + `<p class="note">${data.note} (${data.range.from} ~ ${data.range.to})</p>`;
  html += '<div class="highlight-row">';
  for (const cat of Object.values(data.categories)) {
    html += highlightTile(cat.label, `${cat.count}건`);
  }
  html += '</div>';
  for (const cat of Object.values(data.categories)) {
    html += `<h3>${cat.label} (${cat.count}건)</h3>`;
    if (!cat.items.length) {
      html += '<p class="note">해당 기간 지정 내역이 없습니다.</p>';
      continue;
    }
    html += '<table><thead><tr><th>기업</th><th>유형</th><th>공시일</th><th>지정일</th></tr></thead><tbody>';
    for (const r of cat.items) {
      html += `<tr><td>${r.corp_name}</td><td>${r.type}</td><td>${r.disclosed_date}</td><td>${r.designated_date}</td></tr>`;
    }
    html += '</tbody></table>';
  }
  el.innerHTML = html;
}

async function renderInvestorFlow(card, el) {
  const data = await fetchJson(card.dataFile);
  const insights = INSIGHT_BUILDERS[card.id]?.(data) || [];
  let html = renderHeadlineCallout(card, insights) + usageBox(card.usage) + renderBulletSection(insights.slice(1)) + metaLine(data.updated_at) + `<p class="note">${data.note}</p>`;
  html += `<p class="note">최근 3거래일: ${data.recent_window.strtDd}~${data.recent_window.endDd} · 직전 5거래일: ${data.prior_window.strtDd}~${data.prior_window.endDd}</p>`;
  const investorEntries = Object.entries(data.investors);
  let biggestFlip = null;
  for (const [, info] of investorEntries) {
    for (const f of info.flips || []) {
      if (!biggestFlip || Math.abs(f.swing) > Math.abs(biggestFlip.swing)) biggestFlip = { ...f, investor: info.label };
    }
  }
  const foreignTop = data.investors?.['9000']?.top_net_buy?.[0];
  html += renderKeyMetrics([
    { label: '최대 전환', value: biggestFlip ? `${biggestFlip.investor} · ${biggestFlip.name}` : null },
    { label: '전환폭', value: biggestFlip ? pctSpanValue(biggestFlip.swing) : null },
    { label: '외국인 순매수 1위', value: foreignTop ? `${foreignTop.name} ${formatWonCompact(foreignTop.net)}` : null },
  ]);
  html += '<div class="small-multiples">';
  const swingFmt = (v) => formatWonCompact(v);
  for (const [, info] of investorEntries) {
    html += `<div class="sm-cell"><h4>${info.label} — 매수/매도 전환 상위</h4>`;
    html += info.flips.length
      ? renderRankBars(info.flips, { labelKey: 'name', valueKey: 'swing', fmt: swingFmt, maxItems: 6 })
      : '<p class="note">전환 종목 없음</p>';
    html += '</div>';
  }
  html += '</div>';
  for (const [, info] of investorEntries) {
    html += `<h3>${info.label} — 순매수 상위</h3>`;
    html += '<table><thead><tr><th>종목</th><th>순매수대금(최근3일)</th></tr></thead><tbody>';
    for (const r of info.top_net_buy.slice(0, 8)) {
      html += `<tr><td>${r.name}</td><td>${pctSpanValue(r.net)}</td></tr>`;
    }
    html += '</tbody></table>';
  }
  el.innerHTML = html;
}

function pctSpanValue(n) {
  const cls = n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
  return `<span class="pct ${cls}">${formatWonCompact(n)}</span>`;
}

/** 큰 원화 금액을 억/조 단위로 축약 (랭크바·표에서 자릿수 폭주 방지). */
function formatWonCompact(n) {
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(2)}조`;
  if (abs >= 1e8) return `${sign}${Math.round(abs / 1e8).toLocaleString()}억`;
  if (abs >= 1e4) return `${sign}${Math.round(abs / 1e4).toLocaleString()}만`;
  return `${sign}${abs.toLocaleString()}`;
}

async function renderUsEarnings(card, el) {
  const data = await fetchJson(card.dataFile);
  const insights = INSIGHT_BUILDERS[card.id]?.(data) || [];
  let html = renderHeadlineCallout(card, insights) + usageBox(card.usage) + renderBulletSection(insights.slice(1)) + metaLine(data.updated_at) + `<p class="note">${data.note}</p>`;
  const withReaction = data.items.filter((it) => it.reaction && it.reaction['D+1'] != null);
  const classified = data.items.map((it) => ({ ...it, cls: it.reaction?.['D+1'] != null ? classifyReaction(it.surprise_pct, it.reaction['D+1']) : null }));
  const divergentCount = classified.filter((it) => it.cls?.divergent).length;
  if (withReaction.length) {
    html += renderKeyMetrics([
      { label: '집계 종목수', value: `${data.count}개` },
      { label: 'Reaction Divergence', value: divergentCount ? `${divergentCount}개` : '없음', cls: divergentCount ? 'watch-text' : '' },
    ]);
    html += '<p class="chart-legend-note">발표 후 첫 거래일(D+1) 반응 기준 상위 종목.</p>';
    html += renderRankBars(withReaction.map((it) => ({ symbol: it.symbol, d1: it.reaction['D+1'] })), { labelKey: 'symbol', valueKey: 'd1', fmt: (v) => `${v > 0 ? '+' : ''}${v}%`, maxItems: 20 });
  }
  html += '<table><thead><tr><th>티커</th><th>발표일</th><th>시간</th><th>서프라이즈</th><th>D-1</th><th>D0</th><th>D+1</th><th>D+2</th><th>D+3</th><th>구분</th></tr></thead><tbody>';
  for (const it of classified) {
    const r = it.reaction || {};
    const tagHtml = it.cls ? `<span class="reaction-tag ${it.cls.divergent ? 'divergent' : ''}">${it.cls.label}</span>` : '-';
    html += `<tr><td>${it.symbol}</td><td>${it.report_date}</td><td>${it.report_time}</td><td>${it.surprise_pct != null ? pctSpan(it.surprise_pct) : '-'}</td><td>${pctSpan(r['D-1'])}</td><td>${pctSpan(r.D0)}</td><td>${pctSpan(r['D+1'])}</td><td>${pctSpan(r['D+2'])}</td><td>${pctSpan(r['D+3'])}</td><td>${tagHtml}</td></tr>`;
  }
  html += '</tbody></table>';
  el.innerHTML = html;
}

async function renderKrEarnings(card, el) {
  const data = await fetchJson(card.dataFile);
  const insights = INSIGHT_BUILDERS[card.id]?.(data) || [];
  let html = renderHeadlineCallout(card, insights) + usageBox(card.usage) + renderBulletSection(insights.slice(1)) + metaLine(data.updated_at) + `<p class="note">${data.note}</p>`;
  if (!data.items.length) {
    html += '<p class="note">해당 기간 실적 공시가 없습니다.</p>';
    el.innerHTML = html;
    return;
  }
  const withReaction = data.items.filter((it) => it.reaction && it.reaction['D+1'] != null);
  if (withReaction.length) {
    const best = [...withReaction].sort((a, b) => b.reaction['D+1'] - a.reaction['D+1'])[0];
    const worst = [...withReaction].sort((a, b) => a.reaction['D+1'] - b.reaction['D+1'])[0];
    html += renderKeyMetrics([
      { label: '최고 반응', value: `${best.corp_name} ${pctSpan(best.reaction['D+1'])}` },
      { label: '최저 반응', value: `${worst.corp_name} ${pctSpan(worst.reaction['D+1'])}` },
      { label: '집계 종목수', value: `${withReaction.length}개` },
    ]);
    html += '<p class="chart-legend-note">공시 후 첫 거래일(D+1) 반응 기준.</p>';
    html += renderRankBars(withReaction.map((it) => ({ name: it.corp_name, d1: it.reaction['D+1'] })), { labelKey: 'name', valueKey: 'd1', fmt: (v) => `${v > 0 ? '+' : ''}${v}%`, maxItems: 15 });
  }
  html += '<table><thead><tr><th>기업</th><th>공시일</th><th>D-1</th><th>D0</th><th>D+1</th><th>D+2</th><th>D+3</th><th>D+4</th><th>링크</th></tr></thead><tbody>';
  for (const it of data.items) {
    const r = it.reaction || {};
    const link = it.dart_url ? `<a href="${it.dart_url}" target="_blank" rel="noopener">원문</a>` : '-';
    html += `<tr><td>${it.corp_name}</td><td>${fmtDateStr(it.rcept_dt)}</td><td>${pctSpan(r['D-1'])}</td><td>${pctSpan(r.D0)}</td><td>${pctSpan(r['D+1'])}</td><td>${pctSpan(r['D+2'])}</td><td>${pctSpan(r['D+3'])}</td><td>${pctSpan(r['D+4'])}</td><td>${link}</td></tr>`;
  }
  html += '</tbody></table>';
  el.innerHTML = html;
}

async function renderMarketBrief(card, el) {
  const data = await fetchJson(card.dataFile);
  const insights = INSIGHT_BUILDERS[card.id]?.(data) || [];
  let html = renderHeadlineCallout(card, insights) + usageBox(card.usage) + renderBulletSection(insights.slice(1)) + metaLine(data.updated_at) + `<div class="summary-box">${data.summary}</div>`;
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

async function renderCapitalIncrease(card, el, mode = 'invest') {
  const [paid, free] = await Promise.all(card.dataFile.map(fetchJson));
  const insights = INSIGHT_BUILDERS[card.id]?.(paid, free) || [];
  let html = renderHeadlineCallout(card, insights) + usageBox(card.usage) + renderBulletSection(insights.slice(1)) + metaLine(paid.updated_at);
  const maxRatio = free.items.reduce((max, it) => {
    const r = parseFloat(it.ratio_per_share);
    return Number.isFinite(r) && r > max ? r : max;
  }, 0);
  html += renderKeyMetrics([
    { label: '유상증자', value: `${paid.items.length}건` },
    { label: '무상증자', value: `${free.items.length}건` },
    { label: '최대 무상증자 비율', value: maxRatio > 0 ? `1주당 ${maxRatio}주` : null },
  ]);
  html += viewNote(mode,
    `<ul class="view-note-list">
      <li>유상증자는 발행가만큼 할인되어 신주가 풀리므로 단기적으로 희석·하락 압력입니다.</li>
      <li>무상증자는 유통주식수 증가 기대로 기준일 전후 단기 수급이 몰리는 경우가 많습니다.</li>
      <li>배정기준일·신주 상장(예정)일을 캘린더에 표시해두고 매매 타이밍을 점검하세요.</li>
    </ul>`,
    `<ul class="view-note-list">
      <li>증자방식(제3자배정·일반공모·주주배정)에 따라 대상 투자자와 협상 구조가 달라집니다.</li>
      <li>조달금액·자금 사용목적·최대주주 참여 여부는 이 데이터에 포함되어 있지 않습니다 — DART 원문의 '자금의 사용목적' 항목을 직접 확인하세요.</li>
      <li>무상증자는 자본잉여금의 자본전입으로, 실질적 자금조달이 아닌 주식분할에 가깝습니다.</li>
    </ul>`);
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

async function renderConvertibleBond(card, el, mode = 'invest') {
  const data = await fetchJson(card.dataFile);
  const insights = INSIGHT_BUILDERS[card.id]?.(data) || [];
  let html = renderHeadlineCallout(card, insights) + usageBox(card.usage) + renderBulletSection(insights.slice(1)) + metaLine(data.updated_at) + `<p class="note">최근 ${data.range.from}~${data.range.to} 전환사채 발행결정 공시 ${data.items.length}건</p>`;
  const soonest = [...data.items].filter((i) => i.conversion_start).sort((a, b) => a.conversion_start.localeCompare(b.conversion_start))[0];
  html += renderKeyMetrics([
    { label: '발행결정 공시', value: `${data.items.length}건` },
    { label: '가장 이른 전환청구 시작', value: soonest ? `${soonest.corp_name} ${soonest.conversion_start}` : null },
  ]);
  html += viewNote(mode,
    `<ul class="view-note-list">
      <li>전환청구기간이 열리면 CB 투자자의 전환 후 매도 물량이 잠재 오버행이 됩니다.</li>
      <li>전환가 대비 현재 주가가 높을수록 전환 유인이 커집니다 — 이 데이터에는 실시간 주가가 없어 직접 비교가 필요합니다.</li>
      <li>만기일까지 미전환 물량은 만기 상환(현금 또는 재매도) 이슈로 남습니다.</li>
    </ul>`,
    `<ul class="view-note-list">
      <li>전환가액·전환청구기간·만기일은 Deal Structure의 핵심 조건입니다.</li>
      <li>발행금액·Coupon·YTM·Reset/Call/Put 조건, 투자자·주관사 정보는 이 데이터에 포함되어 있지 않습니다 — 원문 공시(증권신고서)를 확인하세요.</li>
    </ul>`);
  html += renderTable(data.items, [
    ['corp_name', '종목명'], ['stock_code', '코드'], ['rcept_dt', '접수일', fmtDateStr],
    ['conversion_price', '전환가액'], ['pay_date', '납입일'], ['conversion_start', '전환청구 시작'], ['conversion_end', '전환청구 종료'], ['maturity_date', '만기일'],
  ], (row) => `<a href="${row.dart_url}" target="_blank" rel="noopener">원문</a>`);
  el.innerHTML = html;
}

async function renderTreasuryStock(card, el) {
  const data = await fetchJson(card.dataFile);
  const insights = INSIGHT_BUILDERS[card.id]?.(data) || [];
  let html = renderHeadlineCallout(card, insights) + usageBox(card.usage) + renderBulletSection(insights.slice(1)) + metaLine(data.updated_at) + `<p class="note">최근 ${data.range.from}~${data.range.to} 자사주 취득/처분 결정 공시 ${data.items.length}건</p>`;
  const acquireCount = data.items.filter((i) => i.type === '취득').length;
  html += renderKeyMetrics([
    { label: '취득', value: `${acquireCount}건` },
    { label: '처분', value: `${data.items.length - acquireCount}건` },
  ]);
  html += renderTable(data.items, [
    ['corp_name', '종목명'], ['stock_code', '코드'], ['type', '구분'], ['rcept_dt', '접수일', fmtDateStr],
    ['period_start', '기간 시작'], ['period_end', '기간 종료'], ['purpose', '목적'],
  ], (row) => `<a href="${row.dart_url}" target="_blank" rel="noopener">원문</a>`);
  el.innerHTML = html;
}

async function renderInsiderPlan(card, el) {
  const data = await fetchJson(card.dataFile);
  const insights = INSIGHT_BUILDERS[card.id]?.(data) || [];
  let html = renderHeadlineCallout(card, insights) + usageBox(card.usage) + renderBulletSection(insights.slice(1)) + metaLine(data.updated_at) + `<p class="note">최근 ${data.range.from}~${data.range.to} 임원·주요주주 거래계획보고서 ${data.items.length}건</p>`;
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
loadSignals();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
