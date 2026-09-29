// v0.5 선정 규칙 (백테스트 "B 구조"와 동일 구현 — 백테스트와 운영이 이 함수를 같이 쓴다).
// 근거: 전종목 패널 2024-04~2026-09. 사전등록 holdout(2024-04~2025-06)에서 D+5/10/20 모두 후보풀 대비 초과(+).
// 규칙: 시총 상위 30 제외, 20일 평균 거래대금 50억 이상, 미반영 판정이 '일부/상당 반영'이면 제외.
//       점수 = z(미반영) − z(변화 후 수익률, 없으면 20일 수익률) − z(ATR/종가) + 0.5·z(log 거래대금). 상위 N.

export const S7_WEIGHTS = { pricedIn: 1, moveSinceChange: 1, volatility: 1, liquidity: 0.5 };
export const S7_EXCLUDE_TOP_CAP = 30;
const PRICED = { not_yet_priced: 2, unclear: 1, unknown: 0, partially_priced_in: -1, likely_priced_in: -2 };

function zmap(arr, fn) {
  const v = arr.map(fn).filter((x) => x != null && Number.isFinite(x));
  const m = v.reduce((a, b) => a + b, 0) / (v.length || 1);
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, v.length - 1)) || 1;
  return (r) => { const x = fn(r); return x == null || !Number.isFinite(x) ? 0 : (x - m) / sd; };
}

/** rows: featureRowsAt() 결과(그날 유동성 통과 전종목). z-score는 시총 상위 30을 뺀 전체에서 계산 후 필터 적용. */
export function scoreS7(rows) {
  const d = rows.filter((r) => !r.isLargeCap);
  const a = zmap(d, (r) => PRICED[r.pricedIn] ?? 0);
  const s = zmap(d, (r) => r.signalReturn ?? r.r20);
  const v = zmap(d, (r) => r.atrPct);
  const l = zmap(d, (r) => (r.tradVal20 ? Math.log(r.tradVal20) : null));
  const w = S7_WEIGHTS;
  for (const r of d) {
    r.s7 = w.pricedIn * a(r) - w.moveSinceChange * s(r) - w.volatility * v(r) + w.liquidity * l(r);
    r.s7Parts = { pricedIn: a(r), moveSinceChange: -s(r), volatility: -v(r), liquidity: l(r) };
  }
  return d;
}

export function pickS7(rows, n = 5) {
  return scoreS7(rows)
    .filter((r) => r.pricedIn !== 'likely_priced_in' && r.pricedIn !== 'partially_priced_in')
    .sort((x, y) => y.s7 - x.s7)
    .slice(0, n);
}
