// 패널 위에서 선정 규칙(전략) 후보들을 빠르게 비교한다. 매일 규칙에 맞는 종목 중 점수 상위 k개를 T+1 시가에 사서 T+h 종가에 판다고 가정.
// 사용: node scripts/bt-strategies.mjs <panel.json> [h=5] [k=5]
// 기간은 개발(Dev)과 확인(Confirm)으로 나눠 따로 보고한다. 규칙 선택은 Dev 결과로만 한다.

import { readFile } from 'node:fs/promises';
import { basicStats, bootstrapByDay, ROUND_TRIP_COST_PCT } from './lib/backtest-core.mjs';

const [file, hArg, kArg] = process.argv.slice(2);
const h = Number(hArg || 5), K = Number(kArg || 5);
const panel = JSON.parse(await readFile(file, 'utf-8'));
const PERIODS = (process.env.BT_PERIODS || 'Dev:20251001-20260630,Confirm:20260701-20260918').split(',').map((s) => {
  const [name, r] = s.split(':'); const [a, b] = r.split('-'); return { name, from: a, to: b };
});

const byDate = new Map();
const excludeLarge = process.env.BT_EXCLUDE_LARGE === '1'; // Discovery 유니버스(시총 상위 30 제외)로 제한
for (const r of panel.rows) {
  if (r.fwd[h] == null) continue;
  if (excludeLarge && r.isLargeCap) continue;
  if (!byDate.has(r.date)) byDate.set(r.date, []);
  byDate.get(r.date).push(r);
}
for (const arr of byDate.values()) {
  const m = arr.reduce((s, r) => s + r.fwd[h], 0) / arr.length;
  for (const r of arr) { r.poolMean = m; r.ex = r.fwd[h] - m; }
}

const fresh = (d, n = 5) => d != null && d <= n;
const PRICED = { not_yet_priced: 2, unclear: 1, unknown: 0, partially_priced_in: -1, likely_priced_in: -2 };
// 날짜 내 z-score
function zmap(arr, fn) {
  const v = arr.map(fn).filter((x) => x != null && Number.isFinite(x));
  const m = v.reduce((a, b) => a + b, 0) / (v.length || 1);
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, v.length - 1)) || 1;
  return (r) => { const x = fn(r); return x == null || !Number.isFinite(x) ? 0 : (x - m) / sd; };
}

const STRATS = {
  // 비교 기준: 매일 무작위 5종목 = 후보풀 평균 (초과수익 0 기준선)
  'S1 변화+미반영 (변화 후 +5% 이하)': {
    filter: (r) => (fresh(r.evPriceCross) || fresh(r.evMaCross) || fresh(r.evVolSpike)) && r.signalReturn != null && r.signalReturn <= 5,
    score: () => (r) => -r.signalReturn,
  },
  'S2 가격회복/MA돌파만+미반영 (거래량급증 제외)': {
    filter: (r) => (fresh(r.evPriceCross) || fresh(r.evMaCross)) && r.signalReturn != null && r.signalReturn <= 5,
    score: () => (r) => -r.signalReturn,
  },
  'S3 단순 단기반전 (20일 수익률 최저)': {
    filter: () => true,
    score: () => (r) => -(r.r20 ?? 0),
  },
  'S4 미반영+저변동 복합': {
    filter: (r) => r.pricedIn !== 'likely_priced_in',
    score: (arr) => { const a = zmap(arr, (r) => PRICED[r.pricedIn] ?? 0), b = zmap(arr, (r) => r.signalReturn ?? r.r20), c = zmap(arr, (r) => r.atrPct), d = zmap(arr, (r) => r.r20); return (r) => a(r) - b(r) - 0.5 * c(r) - 0.5 * d(r); },
  },
  'S5 변화+미반영+저변동': {
    filter: (r) => (fresh(r.evPriceCross) || fresh(r.evMaCross) || fresh(r.evVolSpike)) && r.signalReturn != null && r.signalReturn <= 5,
    score: (arr) => { const c = zmap(arr, (r) => r.atrPct), s = zmap(arr, (r) => r.signalReturn); return (r) => -s(r) - c(r); },
  },
  'S6 모멘텀 대조군 (20일 수익률 최고)': {
    filter: () => true,
    score: () => (r) => r.r20 ?? -99,
  },
  // --- 2차 가설 (극단값 대신 "초기 단계"를 고른다) ---
  'F1 상승추세 속 눌림 (MA60 위, 5일 하락)': {
    filter: (r) => r.ma60Gap != null && r.ma60Gap > 0 && r.r5 != null && r.r5 < 0 && r.ma20Slope > 0,
    score: (arr) => { const a = zmap(arr, (r) => r.r60), b = zmap(arr, (r) => r.atrPct); return (r) => a(r) - b(r); },
  },
  'F2 초기변화 (신선한 회복/돌파, 변화후 0~+5%, MA20 상승)': {
    filter: (r) => (fresh(r.evPriceCross, 3) || fresh(r.evMaCross, 3)) && r.signalReturn != null && r.signalReturn >= 0 && r.signalReturn <= 5 && r.ma20Slope > 0,
    score: (arr) => { const b = zmap(arr, (r) => r.atrPct), s = zmap(arr, (r) => r.signalReturn); return (r) => -b(r) - 0.5 * s(r); },
  },
  'F3 미반영 판정 + 추세 유지 (MA60 위)': {
    filter: (r) => r.pricedIn === 'not_yet_priced' && r.ma60Gap != null && r.ma60Gap > 0,
    score: (arr) => { const b = zmap(arr, (r) => r.atrPct), n = zmap(arr, (r) => r.novelty); return (r) => n(r) - b(r); },
  },
};
// 엔진 패널이면 엔진 실제 선정도 비교
const enginePicks = new Map((panel.days || []).map((d) => [d.date, new Set(d.picks.map((p) => p.symbol))]));

function run(name, strat, from, to, noRepeat) {
  const perDay = [], exPerDay = [];
  const last = new Map();
  let dayN = 0;
  for (const [date, arr] of [...byDate.entries()].sort()) {
    if (date < from || date > to) continue;
    dayN++;
    let picks;
    if (strat === 'ENGINE') {
      const set = enginePicks.get(date);
      if (!set) continue;
      picks = arr.filter((r) => set.has(r.symbol));
    } else {
      const cand = arr.filter(strat.filter).filter((r) => !noRepeat || !(last.has(r.symbol) && dayN - last.get(r.symbol) < 5));
      const sc = strat.score(arr);
      picks = cand.sort((a, b) => sc(b) - sc(a)).slice(0, K);
    }
    for (const p of picks) last.set(p.symbol, dayN);
    if (picks.length) { perDay.push(picks.map((p) => p.fwd[h])); exPerDay.push(picks.map((p) => p.ex)); }
  }
  const raw = basicStats(perDay.flat()), ex = basicStats(exPerDay.flat());
  const port = perDay.map((d) => d.reduce((a, b) => a + b, 0) / d.length);
  const portEx = exPerDay.map((d) => d.reduce((a, b) => a + b, 0) / d.length);
  const bs = bootstrapByDay(exPerDay);
  return {
    name, days: perDay.length, n: raw.n, winRate: raw.winRate, winNet: raw.n ? (perDay.flat().filter((x) => x - ROUND_TRIP_COST_PCT > 0).length / raw.n) * 100 : null,
    mean: raw.mean, beatPool: ex.winRate, meanEx: ex.mean, portWin: basicStats(port).winRate, portBeat: basicStats(portEx).winRate,
    ci: bs ? `[${bs.lo.toFixed(2)}, ${bs.hi.toFixed(2)}]` : '-',
  };
}

const f = (x, d = 1) => (x == null || !Number.isFinite(x) ? '  -' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}`);
for (const P of PERIODS) {
  console.log(`\n=== ${P.name} ${P.from}~${P.to} | D+${h} | 일 ${K}종목 ===`);
  console.log('전략'.padEnd(34) + '일수 종목  승률% 비용후% 평균%  풀초과율% 평균초과%p [95%CI]        포트승률% 포트>풀%');
  const list = [...(enginePicks.size ? [['ENGINE v0.2 실제 선정', 'ENGINE']] : []), ...Object.entries(STRATS)];
  for (const [name, s] of list) {
    for (const nr of s === 'ENGINE' ? [false] : [false, true]) {
      const r = run(name, s, P.from, P.to, nr);
      console.log(`${(name + (nr ? ' +반복금지' : '')).slice(0, 33).padEnd(34)}${String(r.days).padStart(3)} ${String(r.n).padStart(5)}  ${f(r.winRate)}  ${f(r.winNet)}  ${f(r.mean, 2)}   ${f(r.beatPool)}   ${f(r.meanEx, 2)} ${r.ci.padEnd(16)} ${f(r.portWin)}   ${f(r.portBeat)}`);
    }
  }
}
