// AI Desk 규칙 엔진 — Screening → Candidate Ranking → Market Regime → Risk Review → Morning Meeting.
// 원칙: 모든 계산은 이미 수집된 실제 데이터(KIS/DART/KRX/Yahoo)에서만 나온다.
// LLM은 쓰지 않는다 — 모든 문구는 실제 수치를 템플릿에 대입한 것이며, 근거(evidence)를 항상 함께 남긴다.
// 점수는 투명한 가산 방식이며 각 항목의 근거(scoreBreakdown)를 그대로 노출한다 — 블랙박스 없음.

function fmtWon(n) {
  if (n == null) return '-';
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(2)}조`;
  if (abs >= 1e8) return `${sign}${Math.round(abs / 1e8).toLocaleString()}억`;
  if (abs >= 1e4) return `${sign}${Math.round(abs / 1e4).toLocaleString()}만`;
  return `${sign}${abs.toLocaleString()}`;
}
const sgn = (n) => (n > 0 ? '+' : '');

// 시장 국면별로 어떤 Signal 유형을 우선할지 — 하드코딩 예시가 아니라 이 설정만 바꾸면 전략이 바뀐다.
export const STRATEGY_CONFIG = {
  'Risk-off': { preferred: ['FLOW_REVERSAL', 'MARKET_ALERT', 'LARGE_FINANCING'], avoid: ['MOMENTUM'] },
  Neutral: { preferred: ['FLOW_REVERSAL', 'FLOW_ACCUMULATION'], avoid: [] },
  'Risk-on': { preferred: ['MOMENTUM', 'VOLUME_SPIKE', 'FLOW_ACCUMULATION'], avoid: [] },
};

const SIGNAL_LABEL = {
  FLOW_REVERSAL: 'Flow Reversal',
  FLOW_ACCUMULATION: 'Flow Accumulation',
  SHORT_SPIKE: 'Short Selling Spike',
  MARKET_ALERT: 'Market Alert',
  LARGE_FINANCING: 'Financing Event',
  EARNINGS_REACTION_KR: 'Earnings Reaction',
  MOMENTUM: 'Momentum',
  VOLUME_SPIKE: 'Volume Spike',
};

function addSignal(map, code, name, sig) {
  if (!code || !name) return;
  if (!map.has(code)) map.set(code, { symbol: code, name, signals: [] });
  map.get(code).signals.push(sig);
}

/** 참고 가능한 모든 데이터셋에서 (symbol,name)을 모아 오늘 스크리닝 대상 유니버스를 만든다. */
export function buildUniverse(d) {
  const universe = new Map();
  const add = (code, name) => { if (code && name && !universe.has(code)) universe.set(code, name); };

  for (const q of d.kisQuotes?.items || []) add(q.symbol, q.name);
  for (const it of d.shortSelling?.items || []) add(it.symbol, it.name);
  for (const inv of Object.values(d.investorFlow?.investors || {})) {
    for (const f of inv.flips || []) add(f.symbol, f.name);
    for (const t of inv.top_net_buy || []) add(t.symbol, t.name);
  }
  for (const file of [d.capitalIncreasePaid, d.capitalIncreaseFree, d.convertibleBond, d.treasuryStock, d.insiderPlan]) {
    for (const it of file?.items || []) add(it.stock_code, it.corp_name);
  }
  for (const it of d.krEarnings?.items || []) add(it.stock_code, it.corp_name);

  return universe;
}

// 국내 시장 관행상 분석 우선순위(외국인 > 기관합계 > 연기금 > 개인) — 동점 시그널의 "대표 근거" 선택에만 쓰고
// 점수 자체는 바꾸지 않는다 (투명성 유지).
const INVESTOR_PRIORITY = { 9000: 4, 7050: 3, 6000: 2, 8000: 1 };

function detectFlow(d, map) {
  for (const [code, inv] of Object.entries(d.investorFlow?.investors || {})) {
    const priority = INVESTOR_PRIORITY[code] || 0;
    for (const f of inv.flips || []) {
      const toBuy = f.recent_net > 0;
      addSignal(map, f.symbol, f.name, {
        type: 'FLOW_REVERSAL',
        tone: toBuy ? 'up' : 'down',
        weight: 3,
        investorPriority: priority,
        evidence: `${inv.label} 수급 ${toBuy ? '매도 → 매수' : '매수 → 매도'} 전환 (변화폭 ${fmtWon(f.swing)})`,
        watch: toBuy ? '추가 매수 지속 여부' : '추가 매도 지속 여부',
        invalidation: toBuy ? `${inv.label} 재차 순매도 전환` : `${inv.label} 재차 순매수 전환`,
        cardId: 'investor-flow',
      });
    }
    const top = inv.top_net_buy?.[0];
    if (top) {
      addSignal(map, top.symbol, top.name, {
        type: 'FLOW_ACCUMULATION',
        tone: 'up',
        weight: 2,
        investorPriority: priority,
        evidence: `${inv.label} 순매수 1위 (${fmtWon(top.net)})`,
        watch: `${inv.label} 순매수 지속 여부`,
        invalidation: `${inv.label} 순매도 전환`,
        cardId: 'investor-flow',
      });
    }
  }
}

function detectShort(d, map) {
  for (const it of d.shortSelling?.items || []) {
    if (it.short_ratio_pct < 20) continue;
    addSignal(map, it.symbol, it.name, {
      type: 'SHORT_SPIKE',
      tone: 'watch',
      weight: it.short_ratio_pct >= 30 ? 2 : 1,
      evidence: `공매도 비중 ${it.short_ratio_pct}% (거래대금 상위 유니버스 내)`,
      watch: '반등 시 숏커버링 여부',
      invalidation: '공매도 비중 평상 수준으로 하락',
      cardId: 'short-selling',
    });
  }
}

function detectAlerts(d, map, universe) {
  const nameToCode = new Map();
  for (const [code, name] of universe) nameToCode.set(name, code);
  const levelWeight = { invstriskisu_sub: 3, invstwarnisu_sub: 2, invstcautnisu_sub: 1 };
  const levelTag = { invstriskisu_sub: 'risk', invstwarnisu_sub: 'warn', invstcautnisu_sub: 'caution' };
  for (const [key, cat] of Object.entries(d.marketAlerts?.categories || {})) {
    for (const it of cat.items || []) {
      const code = nameToCode.get(it.corp_name);
      if (!code) continue; // 코드로 확인 안 되는 종목은 후보에 넣지 않는다 (오매칭 방지)
      addSignal(map, code, it.corp_name, {
        type: 'MARKET_ALERT',
        tone: 'down',
        level: levelTag[key] || 'caution',
        weight: levelWeight[key] || 1,
        evidence: `${cat.label} 지정 (${it.designated_date})`,
        watch: '해제 가능 일정 및 거래정지 여부',
        invalidation: null,
        cardId: 'alert-screener',
      });
    }
  }
}

function detectFinancing(d, map) {
  for (const it of d.capitalIncreaseFree?.items || []) {
    const ratio = parseFloat(it.ratio_per_share);
    if (!Number.isFinite(ratio)) continue;
    addSignal(map, it.stock_code, it.corp_name, {
      type: 'LARGE_FINANCING', tone: 'up', weight: ratio >= 0.3 ? 2 : 1,
      evidence: `무상증자 1주당 ${ratio}주 배정`, watch: '권리락 기준일 전후 수급', invalidation: null,
      cardId: 'capital-increase',
    });
  }
  for (const it of d.capitalIncreasePaid?.items || []) {
    addSignal(map, it.stock_code, it.corp_name, {
      type: 'LARGE_FINANCING', tone: 'down', weight: 1,
      evidence: `유상증자 공시 (${it.method || '방식 미상'})`, watch: '배정기준일·신주 상장일', invalidation: null,
      cardId: 'capital-increase',
    });
  }
  for (const it of d.convertibleBond?.items || []) {
    addSignal(map, it.stock_code, it.corp_name, {
      type: 'LARGE_FINANCING', tone: 'watch', weight: 1,
      evidence: `CB 발행결정 (전환가 ${it.conversion_price ?? '-'})`, watch: '전환청구기간 개시일', invalidation: null,
      cardId: 'convertible-bond',
    });
  }
  for (const it of d.treasuryStock?.items || []) {
    const buy = it.type === '취득';
    addSignal(map, it.stock_code, it.corp_name, {
      type: 'LARGE_FINANCING', tone: buy ? 'up' : 'down', weight: buy ? 2 : 1,
      evidence: `자사주 ${it.type} 공시`, watch: buy ? '취득 완료 여부' : '처분 목적', invalidation: null,
      cardId: 'treasury-stock',
    });
  }
}

function detectEarnings(d, map) {
  for (const it of d.krEarnings?.items || []) {
    const d1 = it.reaction?.['D+1'];
    if (d1 == null || Math.abs(d1) < 5) continue;
    addSignal(map, it.stock_code, it.corp_name, {
      type: 'EARNINGS_REACTION_KR', tone: d1 > 0 ? 'up' : 'down', weight: 2,
      evidence: `실적 발표 후 D+1 ${sgn(d1)}${d1}%`, watch: '추가 반응 지속 여부', invalidation: null,
      cardId: 'kr-earnings',
    });
  }
}

function detectMomentumAndVolume(d, map) {
  for (const q of d.kisQuotes?.items || []) {
    const bars = d.kisOhlcv?.symbols?.[q.symbol];
    if (!bars || bars.length < 21) continue;
    const last = bars[bars.length - 1];
    const prior5 = bars[bars.length - 6];
    if (prior5 && prior5.close) {
      const ret5 = ((last.close - prior5.close) / prior5.close) * 100;
      if (Math.abs(ret5) >= 3) {
        addSignal(map, q.symbol, q.name, {
          type: 'MOMENTUM', tone: ret5 > 0 ? 'up' : 'down', weight: ret5 > 0 ? 2 : 1,
          evidence: `최근 5거래일 수익률 ${sgn(ret5)}${ret5.toFixed(1)}%`,
          watch: '추세 지속 여부 (거래대금 동반 확인)', invalidation: '추세 반전 시 신호 무효',
          cardId: 'stock',
        });
      }
    }
    const trailing20 = bars.slice(-21, -1);
    const avgVol = trailing20.reduce((s, b) => s + (b.volume || 0), 0) / (trailing20.length || 1);
    if (avgVol > 0 && last.volume >= avgVol * 2) {
      addSignal(map, q.symbol, q.name, {
        type: 'VOLUME_SPIKE', tone: 'watch', weight: 1,
        evidence: `거래량 20일 평균 대비 ${(last.volume / avgVol).toFixed(1)}배`,
        watch: '거래대금 동반 상승 여부', invalidation: null,
        cardId: 'stock',
      });
    }
  }
}

export function classifyMarketRegime(usMarketBrief) {
  const byId = Object.fromEntries((usMarketBrief?.instruments || []).map((i) => [i.symbol, i]));
  const vix = byId['^VIX'], sp = byId['^GSPC'], nq = byId['^IXIC'], fx = byId['KRW=X'];
  const evidence = [];
  let riskOff = 0, riskOn = 0;
  if (vix?.change_pct != null) {
    evidence.push(`VIX ${sgn(vix.change_pct)}${vix.change_pct}%`);
    if (vix.change_pct >= 5) riskOff++; else if (vix.change_pct <= -5) riskOn++;
  }
  if (sp?.change_pct != null) {
    evidence.push(`S&P500 ${sgn(sp.change_pct)}${sp.change_pct}%`);
    if (sp.change_pct <= -0.5) riskOff++; else if (sp.change_pct >= 0.5) riskOn++;
  }
  if (nq?.change_pct != null) {
    evidence.push(`NASDAQ ${sgn(nq.change_pct)}${nq.change_pct}%`);
    if (nq.change_pct <= -0.5) riskOff++; else if (nq.change_pct >= 0.5) riskOn++;
  }
  if (fx?.change_pct != null) {
    evidence.push(`USD/KRW ${sgn(fx.change_pct)}${fx.change_pct}%`);
    if (fx.change_pct >= 0.3) riskOff++; else if (fx.change_pct <= -0.3) riskOn++;
  }
  const state = riskOff >= 2 ? 'Risk-off' : riskOn >= 2 ? 'Risk-on' : 'Neutral';
  return {
    state,
    evidence,
    strategyPreference: STRATEGY_CONFIG[state]?.preferred || [],
    avoid: STRATEGY_CONFIG[state]?.avoid || [],
  };
}

function scoreCandidate(candidate, regimeState) {
  const pref = STRATEGY_CONFIG[regimeState]?.preferred || [];
  let score = 0;
  const breakdown = [];
  const seen = new Set();
  for (const s of candidate.signals) {
    if (seen.has(s.type)) continue; // 같은 유형은 1회만 점수 반영 (여러 투자주체 flip 중복 방지)
    seen.add(s.type);
    score += s.weight;
    breakdown.push(`+${s.weight} ${SIGNAL_LABEL[s.type] || s.type}`);
  }
  if (candidate.signals.some((s) => pref.includes(s.type))) {
    score += 1;
    breakdown.push(`+1 Regime fit (${regimeState})`);
  }
  return { score, breakdown };
}

function reviewRisk(candidate) {
  const alert = candidate.signals.find((s) => s.type === 'MARKET_ALERT');
  if (alert?.level === 'risk') return { decision: 'REJECT', reason: alert.evidence };
  if (alert) return { decision: 'WATCH', reason: alert.evidence };
  const badFinancing = candidate.signals.find((s) => s.type === 'LARGE_FINANCING' && s.tone !== 'up');
  if (badFinancing) return { decision: 'WATCH', reason: badFinancing.evidence };
  const heavyShort = candidate.signals.find((s) => s.type === 'SHORT_SPIKE' && s.weight >= 2);
  if (heavyShort) return { decision: 'WATCH', reason: heavyShort.evidence };
  return { decision: 'PASS', reason: '특이 리스크 없음' };
}

function buildSelectionDetail(c, regimeState) {
  const dominant = [...c.signals].sort((a, b) => (b.weight - a.weight) || ((b.investorPriority || 0) - (a.investorPriority || 0)))[0];
  const sameDirection = c.signals.filter((s) => s.tone === dominant.tone);
  const counter = c.signals.filter((s) => s.tone !== dominant.tone && s.tone !== 'watch');
  return {
    symbol: c.symbol,
    company: c.name,
    priority: c.score,
    setup: SIGNAL_LABEL[dominant.type] || dominant.type,
    reason: dominant.evidence,
    evidence: sameDirection.map((s) => s.evidence),
    counterEvidence: counter.map((s) => s.evidence),
    confirmation: dominant.watch,
    watch: dominant.watch,
    invalidation: dominant.invalidation || '해당 신호의 근거 지표가 반대로 전환되는 경우',
    risks: c.risk.reason,
    riskDecision: c.risk.decision,
    scoreBreakdown: c.scoreBreakdown,
    marketRegimeAtSelection: regimeState,
    sources: [...new Set(c.signals.map((s) => s.cardId))],
  };
}

/** 전체 파이프라인 실행: UNIVERSE -> SCREEN -> CANDIDATES -> REGIME -> RISK -> MORNING MEETING */
export function buildMorningMeeting(d, dateStr) {
  const universe = buildUniverse(d);
  const candidateMap = new Map();
  detectFlow(d, candidateMap);
  detectShort(d, candidateMap);
  detectAlerts(d, candidateMap, universe);
  detectFinancing(d, candidateMap);
  detectEarnings(d, candidateMap);
  detectMomentumAndVolume(d, candidateMap);

  const regime = classifyMarketRegime(d.usMarketBrief);

  const candidates = [...candidateMap.values()];
  for (const c of candidates) {
    const { score, breakdown } = scoreCandidate(c, regime.state);
    c.score = score;
    c.scoreBreakdown = breakdown;
    c.risk = reviewRisk(c);
  }
  candidates.sort((a, b) => b.score - a.score);

  const passed = candidates.filter((c) => c.risk.decision !== 'REJECT');
  const rejected = candidates.filter((c) => c.risk.decision === 'REJECT');
  const selections = passed.slice(0, 3).map((c) => buildSelectionDetail(c, regime.state));

  return {
    date: dateStr,
    generated_at: new Date().toISOString(),
    marketRegime: regime,
    screening: {
      universeCount: universe.size,
      signalCount: candidates.length,
      passedRiskCount: passed.length,
      rejectedCount: rejected.length,
    },
    selections,
    rejectedCandidates: rejected.map((c) => ({ symbol: c.symbol, name: c.name, reason: c.risk.reason })),
    candidateQueue: candidates.map((c) => ({
      symbol: c.symbol,
      name: c.name,
      score: c.score,
      scoreBreakdown: c.scoreBreakdown,
      signalTypes: [...new Set(c.signals.map((s) => SIGNAL_LABEL[s.type] || s.type))],
      topEvidence: [...c.signals].sort((a, b) => b.weight - a.weight)[0]?.evidence,
      risk: c.risk,
    })),
  };
}
