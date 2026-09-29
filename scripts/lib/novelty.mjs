// Novelty / Change Factor — "최근 처음" 발생한 변화만 점수화하고, 시간이 지나면 decay 시킨다.
// 오래 지속된 상태(예: 몇 달째 MA20 > MA60)는 변화가 아니므로 0점이다.

import { NOVELTY_RULES, NOVELTY_DECAY, FACTOR_WEIGHTS, VARIANT } from './selection-config.mjs';

export function decayOf(days) {
  if (days == null) return { factor: 0, band: 'none' };
  for (const b of NOVELTY_DECAY) if (days <= b.maxDays) return { factor: b.factor, band: b.band };
  return { factor: 0, band: 'none' };
}

/**
 * changeEvents: technical.detectChangeEvents() 결과 (OHLCV 없으면 null → technical 계열 규칙은 분모에서 제외)
 * flow: flow.evalFlow() 결과. 수급 데이터는 "최근 3거래일 vs 직전 5거래일" 창 비교로 설계되어 있어
 *       전환 자체가 최근 3거래일 안의 변화다 → daysSinceChange는 창 중앙값 1로 둔다(근사, 명시).
 */
export function evalNovelty(changeEvents, flow) {
  const weight = FACTOR_WEIGHTS.novelty;
  let earned = 0, applicableMax = 0;
  const events = [];

  for (const rule of NOVELTY_RULES) {
    let ev = null, evaluable = false;
    if (rule.id === 'flowReversal') {
      evaluable = flow?.interpretation !== 'n/a' && flow != null;
      // 방향성 투자주체 매수 전환 + 가격/거래량 확인(=bullish)만 긍정적 변화로 본다.
      if (flow?.interpretation === 'bullish') {
        ev = { previousState: '순매도', currentState: '순매수', changeDate: null, daysSinceChange: 1, approx: true, detail: `${flow.directionalFlip.investor}` };
      }
    } else if (changeEvents) {
      evaluable = rule.id === 'ma20CrossAboveMa60' ? changeEvents.ma20CrossAboveMa60Evaluable : true;
      ev = changeEvents[rule.id];
    }
    if (!evaluable || rule.points <= 0) continue;
    applicableMax += rule.points;
    if (!ev) continue;
    // v0.3: 변화 후 이미 크게 오른 이벤트는 "새롭고 아직 반영 안 된 변화"가 아니므로 점수 없음
    const cap = VARIANT.noveltyMaxReturnSinceChange;
    if (cap != null && ev.returnSinceChange != null && ev.returnSinceChange > cap) continue;
    const { factor, band } = decayOf(ev.daysSinceChange);
    const pts = rule.points * factor;
    events.push({ id: rule.id, label: rule.label, ...ev, band, points: Math.round(pts * 10) / 10 });
    earned += pts;
  }

  if (applicableMax === 0) return { available: false, score: 0, availableWeight: 0, breakdown: [], events: [] };
  const active = events.filter((e) => e.points > 0);
  return {
    available: true,
    score: (earned / applicableMax) * weight,
    availableWeight: weight,
    earnedRaw: earned,
    applicableMax,
    events,
    activeEvents: active,
    freshest: active.length ? Math.min(...active.map((e) => e.daysSinceChange)) : null,
    breakdown: active.map((e) => `+${e.points} ${e.label} (${e.approx ? '최근 3거래일 창' : `${e.daysSinceChange}거래일 전 ${e.changeDate}`}, ${e.band})`),
  };
}
