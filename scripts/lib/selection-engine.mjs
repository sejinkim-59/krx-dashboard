// AI Stock Selection Engine v0.1
// Rule Engine -> Candidate Selection -> Risk Filter -> Ranking. LLM은 이 결과를 바꾸지 않는다.
// 모든 점수는 "Available Weight" 기준으로 정규화한다: 데이터가 없는 Factor/규칙은 0점이 아니라
// 분모(만점)에서 제외한다. 그래서 Data Coverage를 반드시 함께 보여준다 (섹션 10~11).

import { computeFeatures } from './technical.mjs';
import {
  FACTOR_WEIGHTS, TECHNICAL_RULES, TECHNICAL_MAX_RAW, RS_RULES, RS_MAX_RAW,
  FLOW_RULES, FLOW_MAX_RAW, FLOW_THRESHOLDS, CORPORATE_RULES, CORPORATE_MAX_RAW,
  EVENT_THRESHOLDS, COVERAGE_RULES, RISK_THRESHOLDS, STRATEGY_CONFIG, SELECTION_RULES,
  GLOBAL_MAPPING,
} from './selection-config.mjs';

const sgn = (n) => (n > 0 ? '+' : '');
function fmtWon(n) {
  if (n == null) return '-';
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(2)}조`;
  if (abs >= 1e8) return `${sign}${Math.round(abs / 1e8).toLocaleString()}억`;
  if (abs >= 1e4) return `${sign}${Math.round(abs / 1e4).toLocaleString()}만`;
  return `${sign}${abs.toLocaleString()}`;
}

/* ---------------- 1. Universe ---------------- */
export function buildUniverse(d) {
  const universe = new Map(); // code -> {name, hasQuote}
  const add = (code, name) => { if (code && name && !universe.has(code)) universe.set(code, name); };
  for (const q of d.kisQuotes?.items || []) add(q.symbol, q.name);
  for (const it of d.shortSelling?.items || []) add(it.symbol, it.name);
  for (const inv of Object.values(d.investorFlow?.investors || {})) {
    for (const f of inv.flips || []) add(f.symbol, f.name);
    for (const t of inv.top_net_buy || []) add(t.symbol, t.name);
    for (const t of inv.top_net_sell || []) add(t.symbol, t.name);
  }
  for (const file of [d.capitalIncreasePaid, d.capitalIncreaseFree, d.convertibleBond, d.treasuryStock, d.insiderPlan]) {
    for (const it of file?.items || []) add(it.stock_code, it.corp_name);
  }
  for (const it of d.krEarnings?.items || []) add(it.stock_code, it.corp_name);
  return universe;
}

/* ---------------- 2. Feature Store (Technical) ---------------- */
export function buildFeatureStore(d) {
  const features = new Map(); // symbol -> features
  for (const q of d.kisQuotes?.items || []) {
    const bars = d.kisOhlcv?.symbols?.[q.symbol];
    if (!bars) continue;
    const f = computeFeatures(bars, q.week52High);
    if (f) features.set(q.symbol, { ...f, sector: q.sector, name: q.name, quote: q });
  }
  return features;
}

/* ---------------- 3. Market / Sector Proxy (equal-weight — 공식 KOSPI/KOSDAQ 지수 아님, 방법론 명시) ---------------- */
export function computeProxies(features) {
  const all20 = [], all60 = [];
  const bySector = new Map();
  for (const f of features.values()) {
    if (f.return20D != null) all20.push(f.return20D);
    if (f.return60D != null) all60.push(f.return60D);
    if (f.sector) {
      if (!bySector.has(f.sector)) bySector.set(f.sector, { r20: [], r60: [] });
      if (f.return20D != null) bySector.get(f.sector).r20.push(f.return20D);
      if (f.return60D != null) bySector.get(f.sector).r60.push(f.return60D);
    }
  }
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const market = { return20D: avg(all20), return60D: avg(all60), n: all20.length };
  const sectors = new Map();
  for (const [sector, v] of bySector) {
    sectors.set(sector, {
      return20D: avg(v.r20),
      return60D: avg(v.r60),
      breadthPositive20D: v.r20.length ? v.r20.filter((x) => x > 0).length / v.r20.length : null,
      n: v.r20.length,
    });
  }
  return { market, sectors };
}

/* ---------------- 4. Technical Score ---------------- */
function evalTechnical(f, proxies) {
  if (!f) return null;
  const sectorProxy = f.sector ? proxies.sectors.get(f.sector) : null;
  const checks = {
    close_above_ma20: f.ma20 != null ? f.close > f.ma20 : null,
    ma20_above_ma60: f.ma20 != null && f.ma60 != null ? f.ma20 > f.ma60 : null,
    ma60_above_ma120: f.ma60 != null && f.ma120 != null ? f.ma60 > f.ma120 : null,
    ma20_slope_positive: f.ma20Slope != null ? f.ma20Slope > 0 : null,
    ma60_slope_positive: f.ma60Slope != null ? f.ma60Slope > 0 : null,
    near_20d_high: f.dist20DHigh != null ? f.dist20DHigh >= -3 : null,
    breakout_20d: f.dist20DHigh != null ? f.dist20DHigh >= 0 : null,
    near_52w_high: f.dist52WHigh != null ? f.dist52WHigh >= -5 : null,
    volume_ratio_1_5: f.volumeRatio != null ? f.volumeRatio >= 1.5 : null,
    volume_ratio_2_0: f.volumeRatio != null ? f.volumeRatio >= 2.0 : null,
    market_rs_20d_positive: f.return20D != null && proxies.market.return20D != null ? f.return20D - proxies.market.return20D > 0 : null,
    sector_rs_20d_positive: f.return20D != null && sectorProxy?.return20D != null ? f.return20D - sectorProxy.return20D > 0 : null,
  };
  return scoreRules(TECHNICAL_RULES, checks, TECHNICAL_MAX_RAW, FACTOR_WEIGHTS.technical);
}

function evalRelativeStrength(f, proxies) {
  if (!f) return null;
  const sectorProxy = f.sector ? proxies.sectors.get(f.sector) : null;
  const checks = {
    stock_20d_vs_market_positive: f.return20D != null && proxies.market.return20D != null ? f.return20D - proxies.market.return20D > 0 : null,
    stock_60d_vs_market_positive: f.return60D != null && proxies.market.return60D != null ? f.return60D - proxies.market.return60D > 0 : null,
    stock_20d_vs_sector_positive: f.return20D != null && sectorProxy?.return20D != null ? f.return20D - sectorProxy.return20D > 0 : null,
    sector_20d_vs_market_positive: sectorProxy?.return20D != null && proxies.market.return20D != null ? sectorProxy.return20D - proxies.market.return20D > 0 : null,
    sector_breadth_strong: sectorProxy?.breadthPositive20D != null ? sectorProxy.breadthPositive20D >= 0.5 : null,
  };
  return scoreRules(RS_RULES, checks, RS_MAX_RAW, FACTOR_WEIGHTS.relativeStrength);
}

/** rules: [{id,points,label}], checks: {id: true|false|null(=해당사항 평가불가)} */
function scoreRules(rules, checks, maxRaw, weight) {
  let earnedRaw = 0, applicableMax = 0;
  const breakdown = [];
  for (const r of rules) {
    const v = checks[r.id];
    if (v == null) continue; // 평가 불가 — 분모에서 제외
    applicableMax += r.points;
    if (v) { earnedRaw += r.points; breakdown.push(`+${r.points} ${r.label}`); }
  }
  if (applicableMax === 0) return { available: false, score: 0, availableWeight: 0, breakdown: [] };
  const score = (earnedRaw / applicableMax) * weight;
  return { available: true, score, availableWeight: weight, earnedRaw, applicableMax, breakdown };
}

/* ---------------- 5. Flow Score ---------------- */
const INVESTOR_PRIORITY = { 9000: 4, 7050: 3, 6000: 2, 8000: 1 };

function evalFlow(symbol, investorFlow, quote) {
  const checks = { flow_reversal_bullish: null, flow_reversal_bearish: null, flow_accumulation: null, net_buy_to_trading_value_significant: null, net_buy_to_market_cap_significant: null };
  const evidences = [];
  let bestFlip = null, bestNetBuy = null;

  for (const [code, inv] of Object.entries(investorFlow?.investors || {})) {
    const priority = INVESTOR_PRIORITY[code] || 0;
    const flip = (inv.flips || []).find((f) => f.symbol === symbol);
    if (flip) {
      const cand = { ...flip, investor: inv.label, priority };
      if (!bestFlip || Math.abs(cand.swing) > Math.abs(bestFlip.swing) || (Math.abs(cand.swing) === Math.abs(bestFlip.swing) && priority > bestFlip.priority)) bestFlip = cand;
    }
    const rank = (inv.top_net_buy || []).findIndex((t) => t.symbol === symbol);
    if (rank !== -1) {
      const t = inv.top_net_buy[rank];
      const cand = { ...t, investor: inv.label, rank: rank + 1, priority };
      if (!bestNetBuy || rank < bestNetBuy.rank - 1) bestNetBuy = cand;
    }
  }

  if (bestFlip) {
    const toBuy = bestFlip.recent_net > 0;
    checks[toBuy ? 'flow_reversal_bullish' : 'flow_reversal_bearish'] = true;
    evidences.push(`${bestFlip.investor} 수급 ${toBuy ? '매도 → 매수' : '매수 → 매도'} 전환 (변화폭 ${fmtWon(bestFlip.swing)})`);
  } else if (Object.keys(investorFlow?.investors || {}).length) {
    checks.flow_reversal_bullish = false;
  }

  if (bestNetBuy && bestNetBuy.rank <= FLOW_THRESHOLDS.accumulationRank) {
    checks.flow_accumulation = true;
    evidences.push(`${bestNetBuy.investor} 순매수 ${bestNetBuy.rank}위 (${fmtWon(bestNetBuy.net)})`);
  } else if (bestNetBuy) {
    checks.flow_accumulation = false;
  }

  if (quote?.tradingValue && bestNetBuy) {
    const ratio = Math.abs(bestNetBuy.net) / quote.tradingValue;
    checks.net_buy_to_trading_value_significant = ratio >= FLOW_THRESHOLDS.netBuyToTradingValueSignificant;
    if (checks.net_buy_to_trading_value_significant) evidences.push(`순매수/거래대금 ${(ratio * 100).toFixed(1)}%`);
  }
  if (quote?.marketCap && bestNetBuy) {
    // marketCap은 억원 단위(KIS), net은 원 단위이므로 단위를 맞춘다.
    const ratio = Math.abs(bestNetBuy.net) / (quote.marketCap * 1e8);
    checks.net_buy_to_market_cap_significant = ratio >= FLOW_THRESHOLDS.netBuyToMarketCapSignificant;
    if (checks.net_buy_to_market_cap_significant) evidences.push(`순매수/시가총액 ${(ratio * 100).toFixed(2)}%`);
  }

  const result = scoreRules(FLOW_RULES, checks, FLOW_MAX_RAW, FACTOR_WEIGHTS.flow);
  return { ...result, evidences, bestFlip, bestNetBuy };
}

/* ---------------- 6. Corporate/Event Score (경제적 규모 계산 가능한 것만 점수화) ---------------- */
function evalCorporate(symbol, d, quote) {
  const checks = { large_free_distribution: null, dilution_ratio_significant: null };
  const evidences = [];
  const informational = [];

  const free = (d.capitalIncreaseFree?.items || []).find((it) => it.stock_code === symbol);
  if (free) {
    const ratio = parseFloat(free.ratio_per_share);
    if (Number.isFinite(ratio)) {
      checks.large_free_distribution = ratio >= EVENT_THRESHOLDS.largeFreeRatio;
      evidences.push(`무상증자 1주당 ${ratio}주 배정`);
    }
  }
  const paid = (d.capitalIncreasePaid?.items || []).find((it) => it.stock_code === symbol);
  if (paid) {
    if (quote?.sharesOutstanding && paid.new_shares) {
      const ratio = Number(paid.new_shares) / quote.sharesOutstanding;
      checks.dilution_ratio_significant = ratio >= EVENT_THRESHOLDS.dilutionToSharesOutstandingNotable;
      evidences.push(`유상증자 희석비율 ${(ratio * 100).toFixed(1)}% (신주/기존발행주식수)`);
    } else {
      informational.push(`유상증자 공시 (${paid.method || '방식 미상'}) — 희석비율 계산에 필요한 상장주식수 데이터 없음`);
    }
  }
  const cb = (d.convertibleBond?.items || []).find((it) => it.stock_code === symbol);
  if (cb) informational.push(`CB 발행결정 (전환가 ${cb.conversion_price ?? '-'}) — 발행금액 데이터 없어 점수 미반영, 정보로만 표시`);
  const treasury = (d.treasuryStock?.items || []).find((it) => it.stock_code === symbol);
  if (treasury) informational.push(`자사주 ${treasury.type} 공시 — 금액 데이터 없어 점수 미반영, 정보로만 표시`);
  const insider = (d.insiderPlan?.items || []).find((it) => it.stock_code === symbol);
  if (insider) informational.push('내부자 거래계획 제출 (방향·규모 데이터 없음)');

  const result = scoreRules(CORPORATE_RULES, checks, CORPORATE_MAX_RAW, FACTOR_WEIGHTS.corporateEvent);
  return { ...result, evidences, informational, hasBuyback: !!treasury && treasury.type === '취득', hasDisposal: !!treasury && treasury.type === '처분' };
}

/* ---------------- 7. Earnings/Revision — Provider 없음, 항상 MISSING_DATA (섹션 6) ---------------- */
function evalEarningsRevision() {
  return { available: false, score: 0, availableWeight: 0, breakdown: [], missingReason: 'Earnings Surprise/Revision 데이터 Provider 미연결 (Interface만 정의됨)' };
}

/* ---------------- 8. Global Read-through — Mapping이 있는 종목만 (섹션 9) ---------------- */
function evalGlobalReadThrough(symbol) {
  const mapping = GLOBAL_MAPPING.find((m) => m.exposureSymbols.includes(symbol));
  if (!mapping) return { available: false, score: 0, availableWeight: 0, breakdown: [] };
  return {
    available: true,
    score: FACTOR_WEIGHTS.globalReadThrough, // Mapping이 명시적으로 존재하는 경우 = 해당 체인 자체가 근거
    availableWeight: FACTOR_WEIGHTS.globalReadThrough,
    breakdown: [`${mapping.globalSymbol} ${mapping.globalKpi} → ${mapping.chain} → ${mapping.koreanSector}`],
    mapping,
  };
}

/* ---------------- Risk Engine ---------------- */
function evaluateRisk(symbol, name, d, features) {
  const alert = findMarketAlert(name, d.marketAlerts);
  if (alert?.level === 'risk') return { decision: 'REJECT', reason: alert.evidence };
  if (alert) return { decision: 'WATCH', reason: alert.evidence };

  const short = (d.shortSelling?.items || []).find((it) => it.symbol === symbol);
  if (short && short.short_ratio_pct >= RISK_THRESHOLDS.shortRatioSpike) {
    return { decision: 'WATCH', reason: `공매도 비중 ${short.short_ratio_pct}% (과열 임계값 ${RISK_THRESHOLDS.shortRatioSpike}% 이상)` };
  }
  const disposal = (d.treasuryStock?.items || []).find((it) => it.stock_code === symbol && it.type === '처분');
  if (disposal) return { decision: 'WATCH', reason: '자사주 처분 공시 — 잠재 매도물량' };
  const paidOnly = (d.capitalIncreasePaid?.items || []).find((it) => it.stock_code === symbol);
  if (paidOnly) return { decision: 'WATCH', reason: '유상증자 공시 — 배정기준일·신주상장일 확인 필요' };

  if (features?.return5D != null && Math.abs(features.return5D) >= RISK_THRESHOLDS.extremeReturn5D) {
    return { decision: 'WATCH', reason: `최근 5거래일 수익률 ${sgn(features.return5D)}${features.return5D.toFixed(1)}% — 단기 과열/과매도 구간` };
  }
  if (features?.atr14 != null && features.close) {
    const atrRatio = features.atr14 / features.close;
    if (atrRatio >= RISK_THRESHOLDS.atrRatioExtreme) {
      return { decision: 'WATCH', reason: `ATR14/종가 ${(atrRatio * 100).toFixed(1)}% — 변동성 과다` };
    }
  }
  return { decision: 'PASS', reason: '특이 리스크 없음' };
}

function findMarketAlert(name, marketAlerts) {
  const levelWeight = { invstriskisu_sub: 'risk', invstwarnisu_sub: 'warn', invstcautnisu_sub: 'caution' };
  for (const [key, cat] of Object.entries(marketAlerts?.categories || {})) {
    const hit = (cat.items || []).find((it) => it.corp_name === name);
    if (hit) return { level: levelWeight[key] || 'caution', evidence: `${cat.label} 지정 (${hit.designated_date})` };
  }
  return null;
}

/* ---------------- Strategy 분류 ---------------- */
function classifyStrategy(factorResults, independentConfirmations) {
  if (independentConfirmations >= 3) return 'CONFLUENCE';
  if (factorResults.global.available) return 'GLOBAL_READ_THROUGH';
  if (factorResults.corporate.hasBuyback) return 'BUYBACK';
  if (factorResults.corporate.available && factorResults.corporate.earnedRaw > 0) return 'EVENT_DRIVEN';
  if (factorResults.flow.bestFlip) return 'FLOW_REVERSAL';
  if (factorResults.technical.available && factorResults.technical.earnedRaw >= factorResults.technical.applicableMax * 0.6) return 'MOMENTUM';
  return 'WATCH_ONLY';
}

const STRATEGY_LABEL = {
  CONFLUENCE: 'Confluence',
  GLOBAL_READ_THROUGH: 'Global Read-through',
  BUYBACK: 'Buyback',
  EVENT_DRIVEN: 'Event Driven',
  FLOW_REVERSAL: 'Flow Reversal',
  MOMENTUM: 'Momentum',
  WATCH_ONLY: 'Watch Only',
};

/* ---------------- Candidate 조립 ---------------- */
function buildCandidate(symbol, name, d, features, proxies) {
  const quote = d.kisQuotes?.items?.find((q) => q.symbol === symbol) || null;
  const technical = evalTechnical(features, proxies) || { available: false, score: 0, availableWeight: 0, breakdown: [] };
  const relativeStrength = evalRelativeStrength(features, proxies) || { available: false, score: 0, availableWeight: 0, breakdown: [] };
  const flow = evalFlow(symbol, d.investorFlow, quote);
  const corporate = evalCorporate(symbol, d, quote);
  const earningsRevision = evalEarningsRevision();
  const global = evalGlobalReadThrough(symbol);

  const factors = { technical, flow, earningsRevision, corporate, relativeStrength, global };
  let earnedTotal = 0, availableWeightTotal = 0;
  for (const f of Object.values(factors)) {
    if (f.available) { earnedTotal += f.score; availableWeightTotal += f.availableWeight; }
  }
  const normalizedScore = availableWeightTotal > 0 ? (earnedTotal / availableWeightTotal) * 100 : 0;
  const dataCoverage = Math.round((availableWeightTotal / 100) * 100); // 100 = 전체 factor 가중치 합

  const independentConfirmations = Object.values(factors).filter((f) => f.available && f.score > 0).length;

  const strategy = classifyStrategy(factors, independentConfirmations);
  const risk = evaluateRisk(symbol, name, d, features);

  return {
    symbol, name, sector: features?.sector || quote?.sector || null,
    normalizedScore: Math.round(normalizedScore * 10) / 10,
    dataCoverage,
    confidence: dataCoverage >= COVERAGE_RULES.lowConfidenceBelow ? 'Normal' : dataCoverage >= COVERAGE_RULES.minToSelect ? 'Low/Medium' : 'Insufficient',
    independentConfirmations,
    strategy, strategyLabel: STRATEGY_LABEL[strategy],
    factors, risk,
    quote,
  };
}

/* ---------------- Top 20 / Top 5 선정 (Diversity 고려) ---------------- */
function selectFinalPicks(candidates) {
  const eligible = candidates.filter((c) =>
    c.risk.decision !== 'REJECT' &&
    c.independentConfirmations >= SELECTION_RULES.minIndependentConfirmation &&
    c.dataCoverage >= COVERAGE_RULES.minToSelect);
  eligible.sort((a, b) => b.normalizedScore - a.normalizedScore);

  const final = [];
  const strategyCount = {};
  for (const c of eligible) {
    if (final.length >= SELECTION_RULES.finalPickCount) break;
    const cnt = strategyCount[c.strategy] || 0;
    if (cnt >= SELECTION_RULES.maxSameStrategyInFinal) continue;
    final.push(c);
    strategyCount[c.strategy] = cnt + 1;
  }
  // Diversity 제약으로 5개를 못 채웠으면 남은 자리는 점수 순으로 채운다(제약 완화).
  if (final.length < SELECTION_RULES.finalPickCount) {
    for (const c of eligible) {
      if (final.length >= SELECTION_RULES.finalPickCount) break;
      if (!final.includes(c)) final.push(c);
    }
  }
  return { eligible, final };
}

function buildSelectionDetail(c, marketRegimeState) {
  const factorEvidence = [];
  if (c.factors.flow.evidences?.length) factorEvidence.push(...c.factors.flow.evidences);
  if (c.factors.technical.breakdown?.length) factorEvidence.push(...c.factors.technical.breakdown.slice(0, 3).map((b) => `Technical: ${b}`));
  if (c.factors.corporate.evidences?.length) factorEvidence.push(...c.factors.corporate.evidences);
  if (c.factors.global.breakdown?.length) factorEvidence.push(...c.factors.global.breakdown);

  const watchAndInvalidation = c.factors.flow.bestFlip
    ? { watch: c.factors.flow.bestFlip.recent_net > 0 ? '추가 매수 지속 여부' : '추가 매도 지속 여부', invalidation: c.factors.flow.bestFlip.recent_net > 0 ? `${c.factors.flow.bestFlip.investor} 재차 순매도 전환` : `${c.factors.flow.bestFlip.investor} 재차 순매수 전환` }
    : { watch: '핵심 Factor 지속 여부 (거래대금 동반 확인)', invalidation: '핵심 근거 지표 반전 시 신호 무효' };

  return {
    symbol: c.symbol,
    company: c.name,
    sector: c.sector,
    setup: c.strategyLabel,
    strategy: c.strategyLabel,
    score: c.normalizedScore,
    dataCoverage: c.dataCoverage,
    confidence: c.confidence,
    independentConfirmations: c.independentConfirmations,
    reason: factorEvidence[0] || `${c.strategyLabel} Setup`,
    evidence: factorEvidence,
    counterEvidence: c.risk.decision === 'WATCH' ? [c.risk.reason] : [],
    confirmation: watchAndInvalidation.watch,
    watch: watchAndInvalidation.watch,
    invalidation: watchAndInvalidation.invalidation,
    riskDecision: c.risk.decision,
    risks: c.risk.reason,
    corporateInformational: c.factors.corporate.informational || [],
    factorScores: Object.fromEntries(Object.entries(c.factors).map(([k, v]) => [k, v.available ? Math.round(v.score * 10) / 10 : null])),
    scoreBreakdown: buildScoreBreakdown(c.factors),
    signalTypes: activeFactorLabels(c.factors),
    priority: c.normalizedScore,
    marketRegimeAtSelection: marketRegimeState,
    sources: buildSources(c),
  };
}

const FACTOR_DISPLAY_LABEL = { technical: 'Technical', flow: 'Flow', earningsRevision: 'Earnings/Revision', corporate: 'Corporate/Event', relativeStrength: 'Relative Strength', global: 'Global Read-through' };

function buildScoreBreakdown(factors) {
  return Object.entries(factors)
    .filter(([, v]) => v.available)
    .map(([k, v]) => `${FACTOR_DISPLAY_LABEL[k]} ${Math.round(v.score * 10) / 10}/${v.availableWeight}`);
}
function activeFactorLabels(factors) {
  return Object.entries(factors).filter(([, v]) => v.available && v.score > 0).map(([k]) => FACTOR_DISPLAY_LABEL[k]);
}

function buildSources(c) {
  const s = new Set();
  if (c.factors.flow.bestFlip || c.factors.flow.bestNetBuy) s.add('investor-flow');
  if (c.factors.corporate.evidences?.length) s.add('capital-increase');
  if (c.quote) s.add('stock');
  return [...s];
}

/** 전체 파이프라인 실행 */
export function runSelectionEngine(d, dateStr, marketRegimeState) {
  const universe = buildUniverse(d);
  const features = buildFeatureStore(d);
  const proxies = computeProxies(features);

  const candidates = [];
  for (const [symbol, name] of universe) {
    const c = buildCandidate(symbol, name, d, features.get(symbol), proxies);
    candidates.push(c);
  }
  // 섹션 15: Confluence(독립 Confirmation 다수)를 가장 중요하게 취급한다 — 단일 Factor만
  // available인 종목이 그 Factor에서 만점을 받아 Coverage 20%짜리가 100점으로 표시되는
  // 착시를 막기 위해, 정렬은 Confirmation 개수를 1순위로 하고 정규화 점수를 2순위로 한다.
  // (정규화 점수 자체의 계산식은 그대로 유지 — Coverage를 점수에 섞지 않는다는 원칙은 지킨다.)
  candidates.sort((a, b) => (b.independentConfirmations - a.independentConfirmations) || (b.normalizedScore - a.normalizedScore));

  const { eligible, final } = selectFinalPicks(candidates);
  const signalDetected = candidates.filter((c) => c.independentConfirmations >= 1);
  const rejected = candidates.filter((c) => c.risk.decision === 'REJECT');

  return {
    date: dateStr,
    generated_at: new Date().toISOString(),
    methodologyNote: '시장/섹터 상대강도는 공식 KOSPI/KOSDAQ 지수가 아니라 수집된 Liquid Universe의 동일가중 평균 수익률로 계산한 proxy입니다. Earnings/Revision Factor는 데이터 Provider 미연결로 항상 제외(MISSING_DATA)됩니다.',
    universe: {
      totalCount: universe.size,
      technicalCoverageCount: features.size,
      signalDetectedCount: signalDetected.length,
      eligibleCount: eligible.length,
      finalPickCount: final.length,
    },
    topCandidates: candidates.slice(0, SELECTION_RULES.topCandidateCount).map((c) => {
      const detail = buildSelectionDetail(c, marketRegimeState);
      return {
        symbol: c.symbol, name: c.name, sector: c.sector, strategy: c.strategyLabel,
        score: c.normalizedScore, dataCoverage: c.dataCoverage, confidence: c.confidence,
        independentConfirmations: c.independentConfirmations, risk: c.risk,
        topEvidence: detail.evidence[0] || null,
        scoreBreakdown: detail.scoreBreakdown,
        signalTypes: detail.signalTypes.length ? detail.signalTypes : [c.strategyLabel],
      };
    }),
    finalPicks: final.map((c) => buildSelectionDetail(c, marketRegimeState)),
    rejectedCandidates: rejected.slice(0, 20).map((c) => ({ symbol: c.symbol, name: c.name, reason: c.risk.reason })),
  };
}
