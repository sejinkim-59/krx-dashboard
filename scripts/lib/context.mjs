// Priced-in Check / Crowding Penalty — 단독 투자판단이 아니라 Context와 Discovery Ranking Penalty로만 쓴다.

import { PRICED_IN, CROWDING_PENALTY } from './selection-config.mjs';
import { sgn } from './scoring-utils.mjs';

const pct = (v, d = 1) => `${sgn(v)}${v.toFixed(d)}%`;

/**
 * "좋은 변화가 이미 주가에 얼마나 반영됐는가?"
 * signalReturn: 가장 최근 Novelty 이벤트 발생일 이후 수익률 (있으면).
 */
export function evalPricedIn(features, bars, novelty, catalystTiming) {
  if (!features) return { available: false, verdict: 'unknown', lines: [], reason: 'OHLCV 없음 — 가격 반영도 판단 불가' };
  const { return20D: r20, return60D: r60, dist52WHigh: dHigh, volumeRatio } = features;

  let signalReturn = null, signalDate = null;
  const dated = (novelty?.activeEvents || []).filter((e) => e.changeDate);
  if (dated.length && bars) {
    const earliest = dated.reduce((a, b) => (a.daysSinceChange > b.daysSinceChange ? a : b));
    const idx = bars.findIndex((b) => b.time === earliest.changeDate);
    if (idx > 0) {
      const base = bars[idx - 1].close; // 변화 발생 전날 종가 기준
      signalReturn = ((features.close - base) / base) * 100;
      signalDate = earliest.changeDate;
    }
  }
  const earningsReaction = (catalystTiming?.catalysts || []).find((c) => c.type === 'Earnings')?.reactionPct ?? null;

  // 변화 발생 후 수익률이 1순위 근거(섹션 10). 없을 때만 20일 수익률로 대체.
  const moveSinceChange = signalReturn ?? r20;
  const flags = {
    signalRunUp: signalReturn != null && signalReturn >= PRICED_IN.signalRunUp,
    signalRunUpLarge: signalReturn != null && signalReturn >= PRICED_IN.signalRunUpLarge,
    runUp20D: r20 != null && r20 >= PRICED_IN.runUp20D,
    runUp60D: r60 != null && r60 >= PRICED_IN.runUp60D,
    nearHigh: dHigh != null && dHigh >= PRICED_IN.nearHighPct,
    limitedMove: moveSinceChange != null && Math.abs(moveSinceChange) <= PRICED_IN.limitedMove,
  };

  const lines = [];
  if (signalReturn != null) lines.push(`변화 발생(${signalDate}) 이후 ${pct(signalReturn)}`);
  if (r20 != null) lines.push(`20일 ${pct(r20)}`);
  if (r60 != null) lines.push(`60일 ${pct(r60)}`);
  if (dHigh != null) lines.push(`52주 고점 대비 ${pct(dHigh)}`);
  if (volumeRatio != null) lines.push(`거래량 20일 평균 ${volumeRatio.toFixed(1)}배`);
  if (earningsReaction != null) lines.push(`실적 반응 누적 ${pct(earningsReaction)}`);

  let verdict;
  if (flags.signalRunUpLarge || (flags.runUp20D && flags.nearHigh)) verdict = 'likely_priced_in';
  else if (flags.signalRunUp || flags.runUp20D || flags.runUp60D) verdict = 'partially_priced_in';
  else if (flags.limitedMove) verdict = 'not_yet_priced';
  else verdict = 'unclear';

  return { available: true, verdict, flags, signalReturn, lines };
}

export function whyNotPricedText(p) {
  if (!p.available) return null;
  const facts = p.lines.slice(0, 3).join(', ');
  switch (p.verdict) {
    case 'not_yet_priced':
      return `${facts} — 변화 대비 가격 반응이 아직 제한적`;
    case 'unclear':
      return `${facts} — 반영 정도 판단 보류 (과열·저평가 신호 모두 약함)`;
    case 'partially_priced_in':
      return `${facts} — 이미 일부 반영됐을 가능성 (추격 주의)`;
    case 'likely_priced_in':
      return `${facts} — 상당 부분 반영됐을 가능성 높음`;
    default:
      return null;
  }
}

/** Discovery Ranking 전용 Penalty. Market Leader에는 적용하지 않는다. */
export function crowdingPenalty(pricedIn, novelty) {
  const items = [];
  if (pricedIn?.flags?.signalRunUp) items.push({ reason: `변화 발생 후 이미 +${pricedIn.signalReturn.toFixed(1)}%`, points: CROWDING_PENALTY.signalRunUp });
  if (pricedIn?.flags?.runUp20D) items.push({ reason: '최근 20일 급등', points: CROWDING_PENALTY.runUp20D });
  if (pricedIn?.flags?.nearHigh) items.push({ reason: '52주 고점 근접', points: CROWDING_PENALTY.nearHigh });
  const active = novelty?.activeEvents || [];
  if (active.length && active.every((e) => e.band === 'low')) items.push({ reason: '신호 노후화 (6거래일+ 경과)', points: CROWDING_PENALTY.staleNoveltyOnly });
  return { total: items.reduce((s, i) => s + i.points, 0), items };
}
