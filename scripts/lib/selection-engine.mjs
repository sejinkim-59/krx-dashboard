// AI Stock Selection Engine v0.2
// 목적: "좋은 회사"가 아니라 NEW INFORMATION + CHANGE + CATALYST + CONFIRMATION 이 있는 종목을 조기에 발견.
// 판단은 전부 규칙 엔진. LLM은 이 결과를 바꾸지 않는다.
// 점수는 Available Weight 정규화(데이터 없는 Factor는 0점이 아니라 분모 제외) + Data Coverage 별도 표시.

import { computeFeatures, detectChangeEvents } from './technical.mjs';
import { evalNovelty } from './novelty.mjs';
import { evalFlow, buildFlowIntensity } from './flow.mjs';
import { evalCatalystTiming, evalCorporate } from './catalyst.mjs';
import { evalPricedIn, whyNotPricedText, crowdingPenalty } from './context.mjs';
import { scoreRules, unavailable, sgn } from './scoring-utils.mjs';
import {
  FACTOR_WEIGHTS, TECHNICAL_RULES, RS_RULES, VOLUME_SPIKE_RATIO, UNIVERSE_FILTER, COVERAGE_RULES,
  RISK_THRESHOLDS, DISCOVERY_CONFIG, DAILY_SLOTS, SELECTION_RULES, CONFIRMATION_RULES, FACTOR_SOURCE,
  CATALYST_NOT_CONNECTED, VARIANT,
} from './selection-config.mjs';

const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const won = (n) => (n == null ? '-' : `${Math.round(n).toLocaleString()}원`);

export const BUCKET_LABEL = {
  MARKET_LEADER: 'Market Leader',
  DISCOVERY: 'Discovery',
  EVENT_DRIVEN: 'Event-Driven',
  INFLECTION: 'Inflection',
};
const GROUP_LABEL = {
  novelty: 'Novelty', technical: 'Technical', flow: 'Flow', earningsRevision: 'Earnings',
  corporate: 'Corporate', relativeStrength: 'Relative Strength', catalyst: 'Catalyst',
};

/* ---------------- Universe ---------------- */
export function buildUniverse(d) {
  const universe = new Map();
  const add = (code, name) => { if (code && name && !universe.has(code)) universe.set(code, name); };
  for (const q of d.kisQuotes?.items || []) add(q.symbol, q.name);
  for (const it of d.shortSelling?.items || []) add(it.symbol, it.name);
  for (const inv of Object.values(d.investorFlow?.investors || {})) {
    for (const f of inv.flips || []) add(f.symbol, f.name);
    for (const t of inv.top_net_buy || []) add(t.symbol, t.name);
    for (const t of inv.top_net_sell || []) add(t.symbol, t.name);
  }
  for (const file of [d.capitalIncreasePaid, d.capitalIncreaseFree, d.convertibleBond, d.treasuryStock, d.insiderPlan, d.krEarnings]) {
    for (const it of file?.items || []) add(it.stock_code, it.corp_name);
  }
  return universe;
}

/* ---------------- Feature Store (가격 데이터가 있는 종목만) ---------------- */
function buildFeatureStore(d) {
  const store = new Map();
  for (const q of d.kisQuotes?.items || []) {
    const bars = d.kisOhlcv?.symbols?.[q.symbol];
    if (!bars?.length) continue;
    const features = computeFeatures(bars, q.week52High);
    if (!features) continue;
    const last20 = bars.slice(-20);
    features.avgTradingValue20D = last20.length === 20 ? last20.reduce((s, b) => s + b.close * b.volume, 0) / 20 : null;
    store.set(q.symbol, { quote: q, bars, features, changeEvents: detectChangeEvents(bars, VOLUME_SPIKE_RATIO) });
  }
  return store;
}

/** 동일가중 시장/섹터 proxy — 공식 지수 아님(methodologyNote에 명시). 섹터는 3종목 이상일 때만. */
function computeProxies(store) {
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const pick = (k) => [...store.values()].map((e) => e.features[k]).filter((v) => v != null);
  const market = { return5D: avg(pick('return5D')), return20D: avg(pick('return20D')), n: store.size };
  const bySector = new Map();
  for (const e of store.values()) {
    const s = e.quote.sector;
    if (!s) continue;
    if (!bySector.has(s)) bySector.set(s, []);
    bySector.get(s).push(e.features);
  }
  const sectors = new Map();
  for (const [s, fs] of bySector) {
    if (fs.length < 3) continue;
    sectors.set(s, { return20D: avg(fs.map((f) => f.return20D).filter((v) => v != null)), n: fs.length });
  }
  return { market, sectors };
}

function capRanks(d) {
  const ranked = (d.kisQuotes?.items || []).filter((q) => q.marketCap).sort((a, b) => b.marketCap - a.marketCap);
  return new Map(ranked.map((q, i) => [q.symbol, i + 1]));
}

/* ---------------- Technical Confirmation / Relative Strength ---------------- */
function evalTechnical(f) {
  return scoreRules(TECHNICAL_RULES, {
    close_above_ma20: f.ma20 != null ? f.close > f.ma20 : null,
    ma20_above_ma60: f.ma20 != null && f.ma60 != null ? f.ma20 > f.ma60 : null,
    ma20_slope_positive: f.ma20Slope != null ? f.ma20Slope > 0 : null,
    near_20d_high: f.dist20DHigh != null ? f.dist20DHigh >= -3 : null,
    volume_ratio_1_5: f.volumeRatio != null ? f.volumeRatio >= 1.5 : null,
  }, FACTOR_WEIGHTS.technical);
}

function evalRelativeStrength(f, proxies, sector) {
  const m = proxies.market, s = sector ? proxies.sectors.get(sector) : null;
  const ex20 = f.return20D != null && m.return20D != null ? f.return20D - m.return20D : null;
  const ex5 = f.return5D != null && m.return5D != null ? f.return5D - m.return5D : null;
  return scoreRules(RS_RULES, {
    stock_20d_vs_market_positive: ex20 != null ? ex20 > 0 : null,
    stock_20d_vs_sector_positive: f.return20D != null && s?.return20D != null ? f.return20D - s.return20D > 0 : null,
    // 개선 = 최근 5일 초과수익의 일평균 속도가 20일 초과수익 일평균 속도보다 빠름
    rs_improving: ex5 != null && ex20 != null ? ex5 > 0 && ex5 / 5 > ex20 / 20 : null,
  }, FACTOR_WEIGHTS.relativeStrength);
}

/* ---------------- Risk Engine (점수와 분리) ---------------- */
function findMarketAlert(name, marketAlerts) {
  const lv = { invstriskisu_sub: 'risk', invstwarnisu_sub: 'warn', invstcautnisu_sub: 'caution' };
  for (const [key, cat] of Object.entries(marketAlerts?.categories || {})) {
    const hit = (cat.items || []).find((it) => it.corp_name === name);
    if (hit) return { level: lv[key] || 'caution', evidence: `${cat.label} 지정 (${hit.designated_date})` };
  }
  return null;
}

function evaluateRisk(symbol, name, d, f, flow, corporate) {
  const reasons = [];
  const alert = findMarketAlert(name, d.marketAlerts);
  if (alert?.level === 'risk') return { decision: 'REJECT', reason: alert.evidence, reasons: [alert.evidence] };
  if (alert) reasons.push(alert.evidence);
  const short = (d.shortSelling?.items || []).find((it) => it.symbol === symbol);
  if (short && short.short_ratio_pct >= RISK_THRESHOLDS.shortRatioSpike) reasons.push(`공매도 비중 ${short.short_ratio_pct}%`);
  if (flow.interpretation === 'bearish') reasons.push(`${flow.directionalFlip.investor} 매도 전환 확인`);
  reasons.push(...corporate.risks);
  if (f?.return5D != null && Math.abs(f.return5D) >= RISK_THRESHOLDS.extremeReturn5D) reasons.push(`5거래일 ${sgn(f.return5D)}${f.return5D.toFixed(1)}% — 단기 과열/과매도`);
  if (f?.atr14 != null && f.close && f.atr14 / f.close >= RISK_THRESHOLDS.atrRatioExtreme) reasons.push(`ATR14/종가 ${((f.atr14 / f.close) * 100).toFixed(1)}% — 변동성 과다`);
  return reasons.length ? { decision: 'WATCH', reason: reasons.join(' · '), reasons } : { decision: 'PASS', reason: '특이 리스크 없음', reasons: [] };
}

/* ---------------- Independent Confirmation ---------------- */
function confirmationGroups(factors, contradicted) {
  const ratio = (x) => (x.available && x.availableWeight ? x.score / x.availableWeight : 0);
  const groups = [];
  const push = (key, detail) => groups.push({ key, group: GROUP_LABEL[key], source: FACTOR_SOURCE[key], detail });
  const { novelty, technical, flow, relativeStrength, corporate, catalyst } = factors;

  const priceChanges = (novelty.activeEvents || []).filter((e) => e.id !== 'flowReversal' && CONFIRMATION_RULES.noveltyBands.includes(e.band));
  if (priceChanges.length && !contradicted.has('novelty')) push('novelty', priceChanges.map((e) => e.label).join(', '));
  if (ratio(technical) >= CONFIRMATION_RULES.technicalMinRatio && !contradicted.has('technical')) push('technical', `${technical.earnedRaw}/${technical.applicableMax}`);
  if (ratio(flow) >= CONFIRMATION_RULES.flowMinRatio) push('flow', flow.evidences[0] || 'Normalized Flow');
  if (ratio(relativeStrength) >= CONFIRMATION_RULES.rsMinRatio && !contradicted.has('relativeStrength')) push('relativeStrength', `${relativeStrength.earnedRaw}/${relativeStrength.applicableMax}`);
  if (corporate.available && corporate.score > 0) push('corporate', corporate.metrics[0]);
  if (catalyst.available && catalyst.score > 0) push('catalyst', catalyst.breakdown.map((b) => b.replace(/^\+\d+ /, '')).join(', '));
  return groups;
}

/* ---------------- 서술 필드 (WHAT CHANGED / WHY NOW / ...) — 실제 계산값 템플릿, LLM 없음 ---------------- */
function changeLine(e) {
  const when = `${e.changeDate}, ${e.daysSinceChange}거래일 전`;
  if (e.id === 'ma20CrossAboveMa60') return `MA20이 MA60을 상향돌파 (${when})`;
  if (e.id === 'priceCrossAboveMa20') return `종가가 MA20 위로 회복 (${when})`;
  if (e.id === 'volumeSpike') return `거래량 20일 평균 대비 ${e.ratio.toFixed(1)}배로 급증 (${when})`;
  return `${e.label}`;
}

function buildWhatChanged(novelty, flow, catalyst, contradicted) {
  const lines = [];
  if (!contradicted.has('novelty')) {
    for (const e of novelty.activeEvents || []) if (e.id !== 'flowReversal') lines.push(changeLine(e));
  }
  if (flow.interpretation === 'bullish') lines.push(`${flow.directionalFlip.investor} 순매도 → 순매수 전환 (최근 3거래일 vs 직전 5거래일, ${flow.interpretationLine.split('— ')[1]})`);
  for (const c of catalyst.newFilings || []) if (c.direction !== 'supply') lines.push(`새 정보: ${c.label} (${c.filedDaysAgo}거래일 전)`);
  return lines;
}

function buildWhyNow(novelty, catalyst) {
  const parts = [];
  const fresh = (novelty.activeEvents || []).reduce((a, e) => (a == null || e.daysSinceChange < a.daysSinceChange ? e : a), null);
  if (fresh) parts.push(`가장 최근 변화가 ${fresh.approx ? '최근 3거래일 안' : `${fresh.daysSinceChange}거래일 전`} 발생 (Novelty ${fresh.band})`);
  const up = (catalyst.upcoming || []).find((c) => c.direction === 'positive');
  if (up) parts.push(`${up.daysUntil}거래일 안에 확인 이벤트: ${up.label}`);
  return parts.length ? parts.join(' · ') : null;
}

function buildInvalidation(c) {
  const f = c.features;
  const out = [];
  const active = new Set((c.factors.novelty.activeEvents || []).map((e) => e.id));
  if (active.has('ma20CrossAboveMa60') && f) out.push(`MA20(${won(f.ma20)})이 MA60(${won(f.ma60)}) 아래로 재이탈`);
  else if (active.has('priceCrossAboveMa20') && f) out.push(`종가가 MA20(${won(f.ma20)}) 하회`);
  if (c.factors.flow.interpretation === 'bullish') out.push(`${c.factors.flow.directionalFlip.investor} 순매도 재전환`);
  const up = (c.factors.catalyst.upcoming || []).find((x) => x.direction === 'positive');
  if (up) out.push(`${up.type} 일정 정정·철회 공시`);
  return out.length ? out.join(' / ') : '현재 Confirmation 근거 Factor 반전 시';
}

function buildWatch(c) {
  const up = (c.factors.catalyst.upcoming || [])[0];
  if (up) return `${up.label} (${up.daysUntil}거래일 후)`;
  if (c.factors.flow.interpretation === 'bullish') return `${c.factors.flow.directionalFlip.investor} 순매수가 다음 3거래일 지속되는지`;
  if ((c.factors.novelty.activeEvents || []).some((e) => e.id === 'volumeSpike')) return '급증한 거래량이 20일 평균 이상으로 유지되는지';
  return '새 변화 신호 발생 여부';
}

function classifyStrategy(c) {
  const ratio = (x) => (x.available && x.availableWeight ? x.score / x.availableWeight : 0);
  const { novelty, catalyst, corporate, flow, technical } = c.factors;
  const evW = (catalyst.availableWeight || 0) + (corporate.availableWeight || 0);
  const drivers = [
    ['New Change', ratio(novelty)],
    ['Event Driven', evW ? (catalyst.score + corporate.score) / evW : 0],
    ['Flow Confirmed', ratio(flow)],
    ['Trend Confirmation', ratio(technical)],
  ].sort((a, b) => b[1] - a[1]);
  const primary = drivers[0][1] > 0 ? drivers[0][0] : 'Watch Only';
  return c.groups.length >= SELECTION_RULES.confluenceConfirmation && c.sources.size >= CONFIRMATION_RULES.minSources ? `Confluence · ${primary}` : primary;
}

/* ---------------- Candidate 조립 ---------------- */
function buildCandidate(symbol, name, d, entry, ctx) {
  const quote = entry?.quote || null;
  const f = entry?.features || null;

  const flow = evalFlow(symbol, d, f, ctx.intensity);
  const factors = {
    novelty: evalNovelty(entry?.changeEvents || null, flow),
    catalyst: evalCatalystTiming(symbol, name, d, ctx.today),
    corporate: evalCorporate(symbol, d, quote),
    technical: f ? evalTechnical(f) : unavailable('OHLCV 없음'),
    flow,
    earningsRevision: unavailable('컨센서스/Revision Provider 미연결'),
    relativeStrength: f ? evalRelativeStrength(f, ctx.proxies, quote?.sector) : unavailable('OHLCV 없음'),
  };

  // 섹션 5·19: 외국인/기관 매도 전환이 가격으로 확인되면, 가격 계열 긍정 신호를 무비판적으로 합산하지 않는다.
  const contradicted = new Set(flow.interpretation === 'bearish' ? ['technical', 'relativeStrength', 'novelty'] : []);

  let earned = 0, availW = 0;
  for (const [k, x] of Object.entries(factors)) {
    if (!x.available) continue;
    availW += x.availableWeight;
    if (!contradicted.has(k)) earned += x.score;
  }
  const normalizedScore = availW ? (earned / availW) * 100 : 0;
  const dataCoverage = Math.round(availW); // 전체 가중치 합 = 100

  const groups = confirmationGroups(factors, contradicted);
  const sources = new Set(groups.map((g) => g.source));
  const risk = evaluateRisk(symbol, name, d, f, flow, factors.corporate);
  const pricedIn = evalPricedIn(f, entry?.bars, factors.novelty, factors.catalyst);
  const crowding = crowdingPenalty(pricedIn, factors.novelty);
  const capRank = ctx.capRank.get(symbol) ?? null;
  const isLargeCap = capRank != null && capRank <= DISCOVERY_CONFIG.topMarketCapExclusion;
  const liquidityOk = f?.avgTradingValue20D == null ? null : f.avgTradingValue20D >= UNIVERSE_FILTER.minAvgTradingValue20D;

  const whatChanged = buildWhatChanged(factors.novelty, flow, factors.catalyst, contradicted);
  const whyNow = buildWhyNow(factors.novelty, factors.catalyst);
  const whyNotPriced = whyNotPricedText(pricedIn);
  const newSignalCount = (contradicted.has('novelty') ? 0 : (factors.novelty.activeEvents || []).filter((e) => e.id !== 'flowReversal').length)
    + (flow.interpretation === 'bullish' ? 1 : 0)
    + (factors.catalyst.newFilings || []).filter((c) => c.direction !== 'supply').length;
  const hasCatalyst = factors.catalyst.score > 0 || factors.corporate.score > 0;

  const counter = [];
  if (contradicted.size) counter.push(`${flow.directionalFlip.investor} 매도 전환(가격 확인됨) — 기술적/가격 신호와 모순되어 해당 점수 미합산`);
  if (flow.interpretation === 'conflicting') counter.push('외국인/기관 수급 방향이 서로 반대 — Flow 점수 미반영');
  if (pricedIn.verdict === 'partially_priced_in' || pricedIn.verdict === 'likely_priced_in') counter.push(`Priced-in: ${whyNotPriced}`);
  for (const cz of factors.catalyst.catalysts || []) if (cz.direction === 'supply' || cz.direction === 'negative') counter.push(cz.label);
  if (!hasCatalyst) counter.push('향후 20거래일 내 점수화 가능한 Catalyst 없음 — 최상위 Priority(Tier 1) 제한');
  for (const gap of factors.corporate.informational || []) counter.push(`DATA GAP: ${gap}`);

  const c = {
    symbol, name, sector: quote?.sector || null, quote, features: f,
    factors, contradicted, groups, sources, risk, pricedIn, crowding,
    capRank, isLargeCap, liquidityOk, hasCatalyst, newSignalCount,
    normalizedScore: r1(normalizedScore), dataCoverage,
    confidence: dataCoverage >= COVERAGE_RULES.lowConfidenceBelow ? 'Normal' : dataCoverage >= COVERAGE_RULES.minForDiscovery ? 'Low/Medium' : 'Insufficient',
    whatChanged, whyNow, whyNotPriced, counter,
  };
  c.strategy = classifyStrategy(c);
  const atrPct = f?.atr14 && f.close ? (f.atr14 / f.close) * 100 : null;
  const volPenalty = VARIANT.atrPenaltyPerPct && atrPct != null ? Math.max(0, atrPct - 3) * VARIANT.atrPenaltyPerPct : 0;
  c.discoveryScore = r1(c.normalizedScore - (isLargeCap ? 0 : crowding.total + volPenalty));
  c.gate = gateOf(c);
  return c;
}

/* ---------------- Bucket 자격 (왜 탈락했는지도 남긴다) ---------------- */
function gateOf(c) {
  const fails = [];
  if (c.risk.decision === 'REJECT') fails.push('Risk REJECT');
  if (c.groups.length < SELECTION_RULES.minIndependentConfirmation) fails.push(`Independent Factor ${c.groups.length}개 (<${SELECTION_RULES.minIndependentConfirmation})`);
  if (c.sources.size < CONFIRMATION_RULES.minSources) fails.push(`독립 데이터 원천 ${c.sources.size}개 (<${CONFIRMATION_RULES.minSources})`);
  if (c.liquidityOk === false) fails.push('20일 평균 거래대금 50억 미만');
  const answerable = c.whatChanged.length > 0 && c.whyNotPriced != null;
  return { base: fails.length === 0, fails, answerable };
}

function tierOf(c) {
  if (c.hasCatalyst && c.newSignalCount >= 2) return 1;
  if (c.newSignalCount >= 2) return 2; // Catalyst 없으면 최상위 Tier 불가 (섹션 9)
  if (c.hasCatalyst) return 3;
  return 4;
}

const BUCKET_RULES = {
  MARKET_LEADER: {
    ok: (c) => c.gate.base && c.isLargeCap && c.dataCoverage >= COVERAGE_RULES.minForLeader,
    sort: (a, b) => b.normalizedScore - a.normalizedScore || b.groups.length - a.groups.length,
  },
  DISCOVERY: {
    // 목표 조건 "시장이 아직 충분히 반영하지 않았을 가능성" — 허용 판정은 Profile로 관리 (v0.2: likely만 제외)
    ok: (c) => c.gate.base && c.gate.answerable && !c.isLargeCap && c.capRank != null && c.dataCoverage >= COVERAGE_RULES.minForDiscovery
      && VARIANT.allowedPricedIn.includes(c.pricedIn.verdict)
      && (!VARIANT.discoveryRequireAboveMa60 || (c.features?.ma60 != null && c.features.close > c.features.ma60)),
    sort: (a, b) => tierOf(a) - tierOf(b) || b.discoveryScore - a.discoveryScore,
  },
  EVENT_DRIVEN: {
    ok: (c) => c.gate.base && c.gate.answerable && c.hasCatalyst && (VARIANT.name === 'v0.2' || VARIANT.allowedPricedIn.includes(c.pricedIn.verdict)),
    sort: (a, b) => (b.factors.catalyst.score + b.factors.corporate.score) - (a.factors.catalyst.score + a.factors.corporate.score) || b.discoveryScore - a.discoveryScore,
  },
  INFLECTION: {
    ok: (c) => c.gate.base && c.gate.answerable && c.features?.dist52WHigh != null && c.features.dist52WHigh <= SELECTION_RULES.inflectionMaxDist52WHigh
      && (VARIANT.name === 'v0.2' || VARIANT.allowedPricedIn.includes(c.pricedIn.verdict))
      && (c.factors.novelty.activeEvents || []).some((e) => ['ma20CrossAboveMa60', 'priceCrossAboveMa20'].includes(e.id) && CONFIRMATION_RULES.noveltyBands.includes(e.band)),
    // Inflection은 "초기" 반전이 정의이므로, 이미 반영된 반등은 뒤로 보낸다.
    sort: (a, b) => PRICED_RANK[a.pricedIn.verdict] - PRICED_RANK[b.pricedIn.verdict] || b.factors.novelty.score - a.factors.novelty.score || b.discoveryScore - a.discoveryScore,
  },
};
const PRICED_RANK = { not_yet_priced: 0, unclear: 1, unknown: 2, partially_priced_in: 3, likely_priced_in: 4 };

// 한 종목이 여러 Bucket 자격을 가지면, 후보가 가장 적은(대체 불가능한) Bucket부터 배정한다.
// 그래야 중복 제거 후에도 서로 다른 종목으로 슬롯을 최대한 채울 수 있다. 출력 순서는 DAILY_SLOTS 그대로.
function selectDaily(candidates, blocked = new Set()) {
  // 섹션 14 Repeated Same Signal: 최근 N거래일 안에 이미 선정된 종목은 다시 뽑지 않는다 (Profile로 관리)
  const pools = new Map(DAILY_SLOTS.map(({ bucket }) => [bucket, candidates.filter((c) => !blocked.has(c.symbol) && BUCKET_RULES[bucket].ok(c)).sort(BUCKET_RULES[bucket].sort)]));
  const order = [...DAILY_SLOTS].sort((a, b) => pools.get(a.bucket).length / a.count - pools.get(b.bucket).length / b.count);
  const chosen = new Set();
  const picksBy = new Map();
  for (const { bucket, count } of order) {
    const picks = [];
    for (const c of pools.get(bucket)) {
      if (picks.length >= count) break;
      if (chosen.has(c.symbol)) continue; // 중복이면 다음 후보
      chosen.add(c.symbol);
      picks.push(c);
    }
    picksBy.set(bucket, picks);
  }
  return DAILY_SLOTS.map(({ bucket, count }) => {
    const pool = pools.get(bucket), picks = picksBy.get(bucket);
    return { bucket, label: BUCKET_LABEL[bucket], requested: count, qualifiedCount: pool.length, picks, emptyReason: picks.length < count ? emptyReason(bucket, pool.length) : null };
  });
}

function emptyReason(bucket, qualified) {
  const base = qualified ? `조건 충족 ${qualified}종목이 모두 다른 슬롯과 중복` : '오늘 조건을 충족한 종목 없음';
  const rule = {
    MARKET_LEADER: `시총 상위 ${DISCOVERY_CONFIG.topMarketCapExclusion} + Independent Factor ≥${SELECTION_RULES.minIndependentConfirmation} + 원천 ≥${CONFIRMATION_RULES.minSources} + Coverage ≥${COVERAGE_RULES.minForLeader}%`,
    DISCOVERY: `시총 상위 ${DISCOVERY_CONFIG.topMarketCapExclusion} 제외 + WHAT CHANGED/WHY NOT PRICED 답변 가능 + Independent Factor ≥${SELECTION_RULES.minIndependentConfirmation} + 원천 ≥${CONFIRMATION_RULES.minSources}`,
    EVENT_DRIVEN: '점수화 가능한 Catalyst(timing 또는 경제적 크기) + Independent Factor ≥2 + 원천 ≥2',
    INFLECTION: `52주 고점 대비 ${SELECTION_RULES.inflectionMaxDist52WHigh}% 이하 + 5거래일 내 MA20 회복/MA60 돌파 + 원천 ≥2`,
  }[bucket];
  return `${base} (기준: ${rule}) — 빈 슬롯을 억지로 채우지 않음`;
}

/* ---------------- 출력 (섹션 18 스키마 + 기존 UI 호환 필드) ---------------- */
function datasetSources(c) {
  const s = new Set();
  if (c.features) s.add('KIS OHLCV');
  if (c.factors.flow.events?.length) s.add('KRX 투자자별 매매동향');
  for (const x of c.factors.catalyst.catalysts || []) s.add(x.source);
  if (c.factors.corporate.metrics?.length) s.add('DART');
  return [...s];
}

function factorScores(c) {
  const v = (x) => (x.available ? r1(x.score) : null);
  const cat = c.factors.catalyst, cor = c.factors.corporate;
  return {
    noveltyScore: c.contradicted.has('novelty') ? 0 : v(c.factors.novelty),
    catalystScore: cat.available || cor.available ? r1((cat.available ? cat.score : 0) + (cor.available ? cor.score : 0)) : null,
    technicalScore: c.contradicted.has('technical') ? 0 : v(c.factors.technical),
    flowScore: v(c.factors.flow),
    revisionScore: null,
    relativeStrengthScore: c.contradicted.has('relativeStrength') ? 0 : v(c.factors.relativeStrength),
  };
}

function scoreBreakdown(c) {
  return Object.entries(c.factors).filter(([, x]) => x.available)
    .map(([k, x]) => `${GROUP_LABEL[k]} ${c.contradicted.has(k) ? '0(모순)' : r1(x.score)}/${x.availableWeight}`);
}

function toFinal(c, bucket) {
  const confirmation = c.groups.length
    ? c.groups.map((g) => `${g.group}[${g.source}]: ${g.detail}`).join(' + ')
    : 'Independent Confirmation 없음';
  const catalysts = (c.factors.catalyst.catalysts || []).map((x) => x.label);
  const evidence = [
    c.whyNow ? `WHY NOW: ${c.whyNow}` : null,
    c.whyNotPriced ? `WHY NOT PRICED: ${c.whyNotPriced}` : null,
    ...c.whatChanged.slice(1).map((l) => `CHANGED: ${l}`),
    `CONFIRMS: ${confirmation}`,
    ...c.factors.flow.events.slice(0, 2),
    c.factors.flow.interpretationLine,
    ...c.factors.corporate.metrics,
    ...catalysts.filter((l) => !c.whatChanged.some((w) => w.includes(l))).map((l) => `CATALYST: ${l}`),
  ].filter(Boolean);

  return {
    // --- 섹션 18 ---
    symbol: c.symbol,
    company: c.name,
    bucket,
    bucketLabel: BUCKET_LABEL[bucket],
    strategy: c.strategy,
    score: c.normalizedScore,
    ...factorScores(c),
    dataCoverage: c.dataCoverage,
    confidence: c.confidence,
    independentConfirmations: c.groups.length,
    confirmationSources: [...c.sources],
    whatChanged: c.whatChanged,
    whyNow: c.whyNow,
    whyNotPriced: c.whyNotPriced,
    confirmation,
    invalidation: buildInvalidation(c),
    risks: c.risk.reason,
    catalysts,
    sources: datasetSources(c),
    pricedIn: { verdict: c.pricedIn.verdict, facts: c.pricedIn.lines },
    crowdingPenalty: c.isLargeCap ? null : c.crowding,
    marketCapRank: c.capRank,
    flowEvents: c.factors.flow.events,
    flowInterpretation: c.factors.flow.interpretation,
    noveltyEvents: c.factors.novelty.activeEvents,
    // --- 기존 UI 호환 ---
    setup: `${BUCKET_LABEL[bucket]} · ${c.strategy}`,
    reason: c.whatChanged[0] || c.whyNow || '새 변화 신호 없음 (대표주 상태 기반)',
    evidence,
    counterEvidence: c.counter,
    watch: buildWatch(c),
    riskDecision: c.risk.decision,
    scoreBreakdown: scoreBreakdown(c),
    priority: c.normalizedScore,
  };
}

// Candidate Queue = Discovery 관점 정렬(게이트 통과 → Tier → Crowding 반영 점수). 대형주도 같은 기준으로 경쟁.
function queueRank(a, b) {
  return (b.gate.base - a.gate.base) || (tierOf(a) - tierOf(b)) || (b.discoveryScore - a.discoveryScore);
}

/** Universe 전체를 평가해 정렬된 Candidate 목록을 돌려준다 (검증·테스트에서도 사용). */
export function evaluateCandidates(d, today = new Date()) {
  const universe = buildUniverse(d);
  const store = buildFeatureStore(d);
  const ctx = { today, proxies: computeProxies(store), intensity: buildFlowIntensity(d), capRank: capRanks(d) };
  const candidates = [...universe].map(([symbol, name]) => buildCandidate(symbol, name, d, store.get(symbol), ctx));
  candidates.sort(queueRank);
  return { universe, store, candidates };
}

/** 전체 파이프라인 */
export function runSelectionEngine(d, dateStr, marketRegimeState, today = new Date(), { recentPicks = new Map() } = {}) {
  const { universe, store, candidates } = evaluateCandidates(d, today);

  const blocked = new Set(VARIANT.repeatBlockDays ? [...recentPicks].filter(([, daysAgo]) => daysAgo < VARIANT.repeatBlockDays).map(([s]) => s) : []);
  const slots = selectDaily(candidates, blocked);
  const selectedBucket = new Map(slots.flatMap((s) => s.picks.map((p) => [p.symbol, s.bucket])));

  const signalDetected = candidates.filter((c) => c.groups.length >= 1 || c.newSignalCount > 0);
  const baseEligible = candidates.filter((c) => c.gate.base);
  const rejected = candidates.filter((c) => c.risk.decision === 'REJECT');

  return {
    date: dateStr,
    generated_at: new Date().toISOString(),
    engineVersion: VARIANT.name,
    objective: 'NEW INFORMATION + CHANGE + CATALYST + CONFIRMATION — 오늘 새롭게 연구할 가치가 생긴 종목을 조기 발견',
    methodologyNote: [
      '시장/섹터 상대강도는 공식 지수가 아니라 가격 데이터 보유 종목의 동일가중 평균(proxy)입니다.',
      'Earnings/Revision Factor는 컨센서스 Provider 미연결로 항상 제외(MISSING_DATA)됩니다.',
      `시총 순위는 KIS 시세를 조회한 종목(관심종목 + Discovery 추가조회) 안에서의 순위입니다.`,
      '수급 전환의 발생 시점은 "최근 3거래일 vs 직전 5거래일" 창 비교라 일 단위 날짜가 아닌 창 단위입니다.',
      `종목 단위로 연결되지 않은 Catalyst: ${CATALYST_NOT_CONNECTED.join(', ')}.`,
    ].join(' '),
    universe: {
      totalCount: universe.size,
      technicalCoverageCount: store.size,
      signalDetectedCount: signalDetected.length,
      eligibleCount: baseEligible.length,
      finalPickCount: selectedBucket.size,
      largeCapExcluded: DISCOVERY_CONFIG.topMarketCapExclusion,
    },
    dailyOutput: slots.map((s) => ({
      bucket: s.bucket, label: s.label, requested: s.requested, qualifiedCount: s.qualifiedCount,
      picks: s.picks.map((p) => toFinal(p, s.bucket)), emptyReason: s.emptyReason,
    })),
    finalPicks: slots.flatMap((s) => s.picks.map((p) => toFinal(p, s.bucket))),
    topCandidates: candidates.slice(0, SELECTION_RULES.topCandidateCount).map((c) => ({
      symbol: c.symbol, name: c.name, sector: c.sector,
      bucket: selectedBucket.get(c.symbol) || null,
      strategy: c.strategy, score: c.normalizedScore, discoveryScore: c.discoveryScore,
      dataCoverage: c.dataCoverage, confidence: c.confidence,
      independentConfirmations: c.groups.length, confirmationSources: [...c.sources],
      newSignalCount: c.newSignalCount, tier: tierOf(c),
      marketCapRank: c.capRank, isLargeCap: c.isLargeCap,
      whatChanged: c.whatChanged, pricedInVerdict: c.pricedIn.verdict,
      gateFails: c.gate.fails,
      risk: { decision: c.risk.decision, reason: c.risk.reason },
      topEvidence: c.whatChanged[0] || c.factors.flow.events[0] || '새 변화 없음',
      scoreBreakdown: scoreBreakdown(c),
      signalTypes: [selectedBucket.get(c.symbol) ? BUCKET_LABEL[selectedBucket.get(c.symbol)] : c.isLargeCap ? 'Leader 후보' : 'Discovery 후보', ...c.groups.map((g) => g.group)],
    })),
    rejectedCandidates: rejected.slice(0, 20).map((c) => ({ symbol: c.symbol, name: c.name, reason: c.risk.reason })),
  };
}
