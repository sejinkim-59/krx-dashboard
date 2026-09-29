// Normalized Flow — 절대 순매수 금액은 점수에 쓰지 않는다 (섹션 4).
// 수급 EVENT(사실)와 INTERPRETATION(방향 해석)을 분리한다 (섹션 5).

import { FLOW_RULES, FLOW_THRESHOLDS, FACTOR_WEIGHTS, DIRECTIONAL_INVESTORS, RETAIL_INVESTOR_CODE } from './selection-config.mjs';
import { scoreRules, fmtWon, sgn } from './scoring-utils.mjs';

const PRIORITY = { 9000: 3, 7050: 2, 6000: 1 };

/** symbol별 방향성 투자주체(외국인/기관/연기금) 최근 창 순매수 합계. 개인은 제외. */
function directionalNet(investorFlow) {
  const bySymbol = new Map();
  for (const [code, inv] of Object.entries(investorFlow?.investors || {})) {
    if (!DIRECTIONAL_INVESTORS[code]) continue;
    const seen = new Set();
    const add = (symbol, net) => {
      if (seen.has(symbol) || net == null) return;
      seen.add(symbol);
      bySymbol.set(symbol, (bySymbol.get(symbol) || 0) + net);
    };
    for (const f of inv.flips || []) add(f.symbol, f.recent_net);
    for (const t of inv.top_net_buy || []) add(t.symbol, t.net);
    for (const t of inv.top_net_sell || []) add(t.symbol, t.net);
  }
  return bySymbol;
}

/**
 * Universe 내 percentile. intensity = 방향성 순매수 / 시가총액.
 * 시가총액을 아는 종목(KIS 시세 수집 종목)만 비교 가능 — 모르는 종목은 percentile 규칙에서 제외(분모 제외).
 */
export function buildFlowIntensity(d) {
  const net = directionalNet(d.investorFlow);
  const rows = [];
  for (const q of d.kisQuotes?.items || []) {
    if (!q.marketCap || !net.has(q.symbol)) continue;
    const n = net.get(q.symbol);
    const marketCapWon = q.marketCap * 1e8; // KIS hts_avls는 억원 단위
    rows.push({ symbol: q.symbol, net: n, marketCapWon, capIntensity: n / marketCapWon, tvIntensity: q.tradingValue ? n / q.tradingValue : null });
  }
  const sorted = [...rows].sort((a, b) => a.capIntensity - b.capIntensity);
  const map = new Map();
  sorted.forEach((r, i) => {
    map.set(r.symbol, { ...r, percentile: sorted.length > 1 ? (i / (sorted.length - 1)) * 100 : 50, poolSize: sorted.length });
  });
  return map;
}

export function evalFlow(symbol, d, features, intensityMap) {
  const investors = d.investorFlow?.investors || {};
  if (!Object.keys(investors).length) return { ...scoreRules(FLOW_RULES, {}, FACTOR_WEIGHTS.flow), evidences: [], events: [], interpretation: 'n/a' };

  const events = [];
  let dirFlip = null, retailFlip = null, bestAccum = null;
  for (const [code, inv] of Object.entries(investors)) {
    const flip = (inv.flips || []).find((f) => f.symbol === symbol);
    if (flip) {
      const e = { ...flip, code, investor: inv.label, toBuy: flip.recent_net > 0 };
      events.push(e);
      if (code === RETAIL_INVESTOR_CODE) retailFlip = e;
      else if (DIRECTIONAL_INVESTORS[code] && (!dirFlip || PRIORITY[code] > PRIORITY[dirFlip.code])) dirFlip = e;
    }
    if (DIRECTIONAL_INVESTORS[code]) {
      const rank = (inv.top_net_buy || []).findIndex((t) => t.symbol === symbol);
      if (rank !== -1 && rank < FLOW_THRESHOLDS.accumulationRank && (!bestAccum || rank < bestAccum.rank)) {
        bestAccum = { investor: inv.label, rank: rank + 1, net: inv.top_net_buy[rank].net };
      }
    }
  }

  // --- Confirmation 재료: 가격, 거래량, 방향성 투자주체 간 일치 여부 ---
  const r5 = features?.return5D;
  const vr = features?.volumeRatio;
  const dirFlips = events.filter((e) => DIRECTIONAL_INVESTORS[e.code]);
  const conflicting = dirFlips.some((e) => e.toBuy) && dirFlips.some((e) => !e.toBuy);

  let interpretation = 'neutral';
  let confirmNote = null;
  if (dirFlip && !conflicting) {
    const priceOk = r5 != null && (dirFlip.toBuy ? r5 > FLOW_THRESHOLDS.priceConfirmReturn5D : r5 < 0);
    const volOk = vr != null && vr >= FLOW_THRESHOLDS.volumeConfirmRatio;
    if (priceOk || volOk) {
      interpretation = dirFlip.toBuy ? 'bullish' : 'bearish';
      confirmNote = [priceOk ? `5일 수익률 ${sgn(r5)}${r5.toFixed(1)}%` : null, volOk ? `거래량 ${vr.toFixed(1)}배` : null].filter(Boolean).join(', ');
    }
  } else if (conflicting) {
    interpretation = 'conflicting';
  }

  const intensity = intensityMap.get(symbol) || null;
  const checks = {
    // 방향성 투자주체 전환이 없으면 "전환 없음"(false). 개인 전환만 있어도 이 규칙은 false — 방향성 미부여.
    reversalConfirmedBullish: interpretation === 'bullish',
    intensityTopPercentile: intensity ? intensity.net > 0 && intensity.percentile >= FLOW_THRESHOLDS.topPercentile : null,
    accumulationConfirmed: bestAccum ? (r5 == null ? null : r5 >= 0) : false,
  };
  const result = scoreRules(FLOW_RULES, checks, FACTOR_WEIGHTS.flow);

  // --- 표시용 문장: EVENT와 INTERPRETATION을 따로 쓴다 ---
  const eventLines = events.map((e) => `EVENT: ${e.investor} ${e.toBuy ? '매도→매수' : '매수→매도'} 전환 (${intensity ? `변화폭 시총 대비 ${((e.swing / intensity.marketCapWon) * 100).toFixed(3)}%` : `변화폭 ${fmtWon(e.swing)}, 시총 미확인`})`);
  const interpLine = {
    bullish: `INTERPRETATION: Bullish — ${dirFlip?.investor} 매수 전환을 ${confirmNote}가 확인`,
    bearish: `INTERPRETATION: Bearish — ${dirFlip?.investor} 매도 전환을 ${confirmNote}가 확인`,
    conflicting: 'INTERPRETATION: 모순 — 외국인/기관 방향이 서로 반대, 점수 미반영',
    neutral: retailFlip && !dirFlip ? 'INTERPRETATION: Neutral — 개인 수급 전환 단독은 방향성 신호로 보지 않음' : dirFlip ? 'INTERPRETATION: Neutral — 가격/거래량 확인 없음' : null,
  }[interpretation];

  const evidences = [];
  if (interpretation === 'bullish') evidences.push(`${dirFlip.investor} 매수 전환 + ${confirmNote} 확인`);
  if (checks.intensityTopPercentile) evidences.push(`시총 대비 방향성 순매수 강도 상위 ${(100 - intensity.percentile).toFixed(1)}%ile (비교군 ${intensity.poolSize}종목)`);
  if (checks.accumulationConfirmed) evidences.push(`${bestAccum.investor} 순매수 상위 ${bestAccum.rank}위, 5일 가격 하락 없음`);

  return {
    ...result,
    evidences,
    events: eventLines,
    interpretationLine: interpLine,
    interpretation,
    directionalFlip: dirFlip,
    retailFlip,
    intensity,
  };
}
