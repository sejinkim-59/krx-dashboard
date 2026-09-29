// AI Desk 화면들. 전부 이미 계산된 data/morning-meeting.json / learning-log.json을 읽어 보여주기만 한다
// (LLM 호출 없음, 화면에서 재계산 없음 — 모든 판단은 scripts/lib/ai-desk.mjs의 Rule Engine이 배치에서 이미 끝냄).

const AI_DESK_CACHE = { meeting: null, learningSummary: null, learningLog: null };

async function loadMorningMeetingData() {
  if (!AI_DESK_CACHE.meeting) {
    try { AI_DESK_CACHE.meeting = await stockFetchJson('morning-meeting.json'); }
    catch { AI_DESK_CACHE.meeting = null; }
  }
  return AI_DESK_CACHE.meeting;
}
async function loadLearningSummaryData() {
  if (!AI_DESK_CACHE.learningSummary) {
    try { AI_DESK_CACHE.learningSummary = await stockFetchJson('learning-summary.json'); }
    catch { AI_DESK_CACHE.learningSummary = null; }
  }
  return AI_DESK_CACHE.learningSummary;
}
async function loadLearningLogData() {
  if (!AI_DESK_CACHE.learningLog) {
    try { AI_DESK_CACHE.learningLog = await stockFetchJson('learning-log.json'); }
    catch { AI_DESK_CACHE.learningLog = null; }
  }
  return AI_DESK_CACHE.learningLog;
}

function regimeTone(state) {
  return state === 'Risk-off' ? 'down' : state === 'Risk-on' ? 'up' : 'flat';
}

function jumpToStock(symbol) {
  switchView('stock');
  initStockWorkspace().then(() => selectStock(symbol));
}

function wireJumps(container) {
  container.querySelectorAll('[data-symbol]').forEach((el) => {
    el.addEventListener('click', () => jumpToStock(el.dataset.symbol));
  });
}

/* ---------------- Home: 압축 Morning Brief ---------------- */
async function loadMorningBrief() {
  const el = document.getElementById('morningBrief');
  if (!el) return;
  const meeting = await loadMorningMeetingData();
  if (!meeting) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `
    <div class="mb-head">
      <span class="mb-eyebrow">AI MORNING MEETING</span>
      <span class="mb-regime ${regimeTone(meeting.marketRegime.state)}">${meeting.marketRegime.state}</span>
    </div>
    <p class="mb-funnel">${meeting.screening.universeCount}종목 분석 · Signal ${meeting.screening.signalCount}건 · Risk 통과 ${meeting.screening.passedRiskCount}건 · Top ${meeting.selections.length} 선정</p>
    <div class="mb-top-list">
      ${meeting.selections.map((s, i) => `
        <button class="mb-top-item" data-symbol="${s.symbol}">
          <span class="mb-top-index">0${i + 1}</span>
          <span class="mb-top-body">
            <span class="mb-top-name">${s.company} <span class="mb-top-setup">${s.setup}</span></span>
            <span class="mb-top-reason">${s.reason}</span>
          </span>
        </button>`).join('')}
    </div>
    <button class="mb-more" data-goto="morning">전체 모닝미팅 보기 →</button>
  `;
  wireJumps(el);
  el.querySelector('[data-goto]')?.addEventListener('click', () => switchView('morning'));
}

/* ---------------- 공통: Selection Card (WHY/EVIDENCE/COUNTER/WATCH/INVALIDATION) ---------------- */
function renderSelectionCard(s, idx) {
  return `
    <div class="selection-card">
      <div class="sc-head">
        ${idx ? `<span class="sc-index">0${idx}</span>` : ''}
        <button class="sc-name" data-symbol="${s.symbol}">${s.company}</button>
        <span class="sc-setup">${s.setup}</span>
        ${s.riskDecision === 'WATCH' ? '<span class="sc-risk-tag">WATCH</span>' : ''}
      </div>
      <div class="sc-section"><span class="sc-label">WHY TODAY</span><p>${s.reason}</p></div>
      ${s.evidence?.length ? `<div class="sc-section"><span class="sc-label">EVIDENCE</span><ul>${s.evidence.map((e) => `<li>${e}</li>`).join('')}</ul></div>` : ''}
      ${s.counterEvidence?.length ? `<div class="sc-section"><span class="sc-label">COUNTER EVIDENCE</span><ul>${s.counterEvidence.map((e) => `<li>${e}</li>`).join('')}</ul></div>` : ''}
      <div class="sc-grid">
        <div><span class="sc-label">CONFIRMATION</span><p>${s.confirmation}</p></div>
        <div><span class="sc-label">WATCH</span><p>${s.watch}</p></div>
        <div><span class="sc-label">INVALIDATION</span><p>${s.invalidation}</p></div>
      </div>
      <div class="sc-footer">
        <span class="sc-score" title="${(s.scoreBreakdown || []).join(', ')}">Score ${s.priority ?? s.score}</span>
        <span class="sc-risk">Risk: ${s.risks || s.risk?.reason}</span>
      </div>
    </div>`;
}

/* ---------------- 모닝미팅 (전체) ---------------- */
async function loadMorningView() {
  const body = document.getElementById('morningBody');
  body.innerHTML = '<p class="hero-empty">불러오는 중...</p>';
  const meeting = await loadMorningMeetingData();
  if (!meeting) { body.innerHTML = '<p class="note">모닝미팅 데이터가 아직 없습니다. 다음 배치(최대 30분)를 기다려주세요.</p>'; return; }
  const r = meeting.marketRegime;
  body.innerHTML = `
    <div class="regime-strip">
      <span class="regime-state ${regimeTone(r.state)}">${r.state}</span>
      <span class="regime-evidence">${r.evidence.join(' · ')}</span>
    </div>
    <p class="note">${meeting.screening.universeCount}종목 분석 → Signal ${meeting.screening.signalCount}건 → Risk Review 통과 ${meeting.screening.passedRiskCount}건 → Top ${meeting.selections.length} 선정 (제외 ${meeting.rejectedCandidates.length}건)</p>
    <div class="selection-list">${meeting.selections.map((s, i) => renderSelectionCard(s, i + 1)).join('')}</div>
    ${meeting.rejectedCandidates.length ? `<h3>Risk Review 제외 후보</h3><ul class="bullet-list">${meeting.rejectedCandidates.map((r2) => `<li class="bullet-row"><span class="bullet-dot"></span><span>${r2.name} — ${r2.reason}</span></li>`).join('')}</ul>` : ''}
  `;
  wireJumps(body);
}

/* ---------------- 스크리닝부 ---------------- */
async function loadScreeningView() {
  const body = document.getElementById('screeningBody');
  body.innerHTML = '<p class="hero-empty">불러오는 중...</p>';
  const meeting = await loadMorningMeetingData();
  if (!meeting) { body.innerHTML = '<p class="note">데이터가 없습니다.</p>'; return; }
  body.innerHTML = `
    <div class="funnel-row">
      <div class="funnel-cell"><span class="funnel-value">${meeting.screening.universeCount}</span><span class="funnel-label">Universe</span></div>
      <div class="funnel-cell"><span class="funnel-value">${meeting.screening.signalCount}</span><span class="funnel-label">Signal 발생</span></div>
      <div class="funnel-cell"><span class="funnel-value">${meeting.screening.passedRiskCount}</span><span class="funnel-label">Risk 통과</span></div>
      <div class="funnel-cell"><span class="funnel-value">${meeting.selections.length}</span><span class="funnel-label">Morning Meeting 선정</span></div>
    </div>
    <h3>Candidate Queue</h3>
    <div class="feed-list">${meeting.candidateQueue.map((c, i) => `
      <button class="feed-row" data-symbol="${c.symbol}">
        <span class="feed-type">${String(i + 1).padStart(2, '0')}</span>
        <span class="feed-entity">${c.name}</span>
        <span class="feed-line">${c.signalTypes.join(' · ')} — ${c.topEvidence}</span>
        <span class="feed-metric">${c.score}</span>
      </button>`).join('')}</div>
  `;
  wireJumps(body);
}

/* ---------------- 분석부 (master-detail) ---------------- */
let researchSelectedSymbol = null;
async function loadResearchView() {
  const body = document.getElementById('researchBody');
  body.innerHTML = '<p class="hero-empty">불러오는 중...</p>';
  const meeting = await loadMorningMeetingData();
  if (!meeting || !meeting.candidateQueue.length) { body.innerHTML = '<p class="note">분석할 후보가 없습니다.</p>'; return; }
  researchSelectedSymbol = researchSelectedSymbol || meeting.selections[0]?.symbol || meeting.candidateQueue[0].symbol;
  body.innerHTML = `
    <div class="research-queue" id="researchQueue">${meeting.candidateQueue.map((c) => `
      <button class="rq-item ${c.symbol === researchSelectedSymbol ? 'active' : ''}" data-symbol="${c.symbol}">
        <span class="rq-name">${c.name}</span><span class="rq-score">${c.score}</span>
      </button>`).join('')}</div>
    <div class="research-detail" id="researchDetail"></div>
  `;
  const renderDetail = () => {
    const detail = document.getElementById('researchDetail');
    const sel = meeting.selections.find((s) => s.symbol === researchSelectedSymbol);
    if (sel) { detail.innerHTML = renderSelectionCard(sel); wireJumps(detail); return; }
    const c = meeting.candidateQueue.find((x) => x.symbol === researchSelectedSymbol);
    if (!c) { detail.innerHTML = ''; return; }
    detail.innerHTML = `
      <div class="selection-card">
        <div class="sc-head"><button class="sc-name" data-symbol="${c.symbol}">${c.name}</button><span class="sc-setup">${c.signalTypes.join(' · ')}</span></div>
        <div class="sc-section"><span class="sc-label">TOP EVIDENCE</span><p>${c.topEvidence}</p></div>
        <div class="sc-footer"><span class="sc-score" title="${c.scoreBreakdown.join(', ')}">Score ${c.score}</span><span class="sc-risk">Risk: ${c.risk.decision} — ${c.risk.reason}</span></div>
      </div>`;
    wireJumps(detail);
  };
  renderDetail();
  body.querySelectorAll('.rq-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      researchSelectedSymbol = btn.dataset.symbol;
      body.querySelectorAll('.rq-item').forEach((b) => b.classList.toggle('active', b === btn));
      renderDetail();
    });
  });
}

/* ---------------- 마켓부 ---------------- */
async function loadMarketDeskView() {
  const body = document.getElementById('marketDeskBody');
  body.innerHTML = '<p class="hero-empty">불러오는 중...</p>';
  const meeting = await loadMorningMeetingData();
  if (!meeting) { body.innerHTML = '<p class="note">데이터가 없습니다.</p>'; return; }
  const r = meeting.marketRegime;
  body.innerHTML = `
    <div class="regime-block">
      <span class="regime-state-lg ${regimeTone(r.state)}">${r.state}</span>
      <div class="regime-detail-row"><span class="sc-label">EVIDENCE</span><ul>${r.evidence.map((e) => `<li>${e}</li>`).join('')}</ul></div>
      <div class="regime-detail-row"><span class="sc-label">STRATEGY PREFERENCE</span><ol>${r.strategyPreference.map((s) => `<li>${s}</li>`).join('')}</ol></div>
      ${r.avoid.length ? `<div class="regime-detail-row"><span class="sc-label">AVOID</span><ul>${r.avoid.map((s) => `<li>${s}</li>`).join('')}</ul></div>` : ''}
    </div>
  `;
}

/* ---------------- 리스크관리부 ---------------- */
async function loadRiskDeskView() {
  const body = document.getElementById('riskDeskBody');
  body.innerHTML = '<p class="hero-empty">불러오는 중...</p>';
  const meeting = await loadMorningMeetingData();
  if (!meeting) { body.innerHTML = '<p class="note">데이터가 없습니다.</p>'; return; }
  body.innerHTML = `<table><thead><tr><th>종목</th><th>Primary Signal</th><th>Risk 사유</th><th>Decision</th></tr></thead><tbody>
    ${meeting.candidateQueue.map((c) => `<tr class="${c.risk.decision === 'REJECT' ? 'row-flag' : ''}">
      <td><button class="link-btn" data-symbol="${c.symbol}">${c.name}</button></td>
      <td>${c.topEvidence}</td>
      <td>${c.risk.reason}</td>
      <td><b class="${c.risk.decision === 'PASS' ? 'up' : c.risk.decision === 'REJECT' ? 'down' : ''}">${c.risk.decision}</b></td>
    </tr>`).join('')}
  </tbody></table>`;
  wireJumps(body);
}

/* ---------------- 학습부 ---------------- */
async function loadLearningView() {
  const body = document.getElementById('learningBody');
  body.innerHTML = '<p class="hero-empty">불러오는 중...</p>';
  const [summary, log] = await Promise.all([loadLearningSummaryData(), loadLearningLogData()]);
  if (!summary || !summary.totalEntries) {
    body.innerHTML = '<p class="hero-empty">학습 데이터 축적 중입니다 — 선정 이력이 쌓이는 대로 Signal별 성과가 표시됩니다.</p>';
    return;
  }
  let html = `<p class="note">누적 선정 ${summary.totalEntries}건 · D+5 성과 확정 ${summary.resolvedD5}건</p>`;
  if (summary.bySetup?.length) {
    html += `<h3>Setup별 평균 D+5 성과</h3><table><thead><tr><th>Setup</th><th>건수</th><th>평균 D+5</th></tr></thead><tbody>${summary.bySetup.map((s) => `<tr><td>${s.setup}</td><td>${s.count}</td><td>${pctSpan(s.avgD5)}</td></tr>`).join('')}</tbody></table>`;
  } else {
    html += '<p class="hero-empty">아직 D+5 성과가 확정된 건이 없습니다 (선정 후 5거래일 경과가 필요합니다).</p>';
  }
  const entries = (log?.entries || []).slice().reverse().slice(0, 50);
  html += `<h3>전체 로그</h3><table><thead><tr><th>일자</th><th>종목</th><th>Setup</th><th>Regime</th><th>선정가</th><th>D+1</th><th>D+5</th><th>D+20</th></tr></thead><tbody>${entries.map((e) => `<tr><td>${fmtDateStr(e.date)}</td><td>${e.name}</td><td>${e.setup}</td><td>${e.marketRegime}</td><td>${e.priceAtSelection != null ? e.priceAtSelection.toLocaleString() : '-'}</td><td>${e.d1 != null ? pctSpan(e.d1) : '-'}</td><td>${e.d5 != null ? pctSpan(e.d5) : '-'}</td><td>${e.d20 != null ? pctSpan(e.d20) : '-'}</td></tr>`).join('')}</tbody></table>`;
  body.innerHTML = html;
}
