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
// 시장 국면 필터: KODEX 200 종가가 20일선 위(up)/아래(down)인 날만 (T 시점 정보만 사용)
const regime = process.env.BT_REGIME || 'all';
const kBars = JSON.parse(await readFile(new URL('../.cache/backtest/bars-069500.json', import.meta.url), 'utf-8'));
const upDay = new Map();
for (let i = 19; i < kBars.length; i++) {
  const ma = kBars.slice(i - 19, i + 1).reduce((s, b) => s + b.close, 0) / 20;
  upDay.set(kBars[i].time.replace(/-/g, ''), kBars[i].close > ma);
}
const STRATS_ONLY = process.env.BT_ONLY ? new Set(process.env.BT_ONLY.split(',')) : null;
for (const r of panel.rows) {
  if (r.fwd[h] == null) continue;
  if (excludeLarge && r.isLargeCap) continue;
  if (process.env.BT_ONLY_LARGE === '1' && !r.isLargeCap) continue;
  if (regime !== 'all' && upDay.get(r.date) !== (regime === 'up')) continue;
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
  // 3차: 개발 구간(2025-10~2026-06) 전종목 패널에서 4개 분기 모두 부호가 일관된 요소만 결합
  'S7 미반영+저변동+유동성 복합': {
    filter: (r) => r.pricedIn !== 'likely_priced_in' && r.pricedIn !== 'partially_priced_in',
    score: (arr) => {
      const a = zmap(arr, (r) => PRICED[r.pricedIn] ?? 0), s = zmap(arr, (r) => r.signalReturn ?? r.r20), v = zmap(arr, (r) => r.atrPct), l = zmap(arr, (r) => (r.tradVal20 ? Math.log(r.tradVal20) : null));
      return (r) => a(r) - s(r) - v(r) + 0.5 * l(r);
    },
  },
  'S8 S7 + 신선한 가격회복(3일 내)': {
    filter: (r) => r.pricedIn !== 'likely_priced_in' && r.pricedIn !== 'partially_priced_in' && fresh(r.evPriceCross, 3),
    score: (arr) => {
      const s = zmap(arr, (r) => r.signalReturn ?? r.r20), v = zmap(arr, (r) => r.atrPct), l = zmap(arr, (r) => (r.tradVal20 ? Math.log(r.tradVal20) : null));
      return (r) => -s(r) - v(r) + 0.5 * l(r);
    },
  },
  // 4차: 수급 패널 전용 (flow 필드 없는 패널에서는 선정 0건)
  'FL 수급 확인만 (외국인/기관 매수전환+가격/거래량 확인, 강도순)': {
    filter: (r) => r.flowBullish === 1,
    score: () => (r) => r.capIntPct ?? 0,
  },
  'S7F S7 + 수급 매수 확인': {
    filter: (r) => r.flowBullish === 1 && r.pricedIn !== 'likely_priced_in' && r.pricedIn !== 'partially_priced_in',
    score: (arr) => STRATS['S7 미반영+저변동+유동성 복합'].score(arr),
  },
  'S7C S7 + WHAT CHANGED 존재 (수급확인 또는 신선한 변화)': {
    filter: (r) => (r.flowBullish === 1 || fresh(r.evPriceCross) || fresh(r.evMaCross) || fresh(r.evVolSpike)) && r.pricedIn !== 'likely_priced_in' && r.pricedIn !== 'partially_priced_in' && r.flowBullish !== undefined,
    score: (arr) => STRATS['S7 미반영+저변동+유동성 복합'].score(arr),
  },
  'S7X S7 - 수급 매도확인 제외': {
    filter: (r) => r.flowBullish !== undefined && r.flowBullish !== -1 && r.pricedIn !== 'likely_priced_in' && r.pricedIn !== 'partially_priced_in',
    score: (arr) => STRATS['S7 미반영+저변동+유동성 복합'].score(arr),
  },
  'S7FI S7 + 외국인 순매수 강도': {
    filter: (r) => r.fNet3Int !== undefined && r.pricedIn !== 'likely_priced_in' && r.pricedIn !== 'partially_priced_in',
    score: (arr) => { const base = STRATS['S7 미반영+저변동+유동성 복합'].score(arr), fi = zmap(arr, (r) => r.fNet3Int); return (r) => base(r) + 0.5 * fi(r); },
  },
  'S7CF S7C + 외국인 순매수 강도': {
    filter: (r) => STRATS['S7C S7 + WHAT CHANGED 존재 (수급확인 또는 신선한 변화)'].filter(r),
    score: (arr) => STRATS['S7FI S7 + 외국인 순매수 강도'].score(arr),
  },
  // 5차: 하루 5종목 전체 출력 구조 비교 (전체 유니버스 패널에서 실행, BT_EXCLUDE_LARGE 없이)
  'A 구조 1/2/1/1 (Leader1+Discovery2+Inflection1+보충1, S7C 순위)': {
    pick: (arr) => {
      const S7C = STRATS['S7C S7 + WHAT CHANGED 존재 (수급확인 또는 신선한 변화)'];
      const sc = S7C.score(arr.filter((r) => !r.isLargeCap));
      const scL = S7C.score(arr.filter((r) => r.isLargeCap));
      const chosen = new Set(), out = [];
      const take = (list, n, key) => { for (const r of list.sort((a, b) => key(b) - key(a))) { if (out.length >= 5 || n <= 0) break; if (chosen.has(r.symbol)) continue; chosen.add(r.symbol); out.push(r); n--; } };
      take(arr.filter((r) => r.isLargeCap && S7C.filter(r)), 1, scL);
      take(arr.filter((r) => !r.isLargeCap && S7C.filter(r)), 2, sc);
      take(arr.filter((r) => !r.isLargeCap && S7C.filter(r) && r.dHigh52 != null && r.dHigh52 <= -20 && (fresh(r.evPriceCross) || fresh(r.evMaCross))), 1, sc);
      take(arr.filter((r) => !r.isLargeCap && S7C.filter(r)), 5 - out.length, sc);
      return out;
    },
  },
  'B 구조 Discovery 5 (S7, 변화 요건 없음)': {
    pick: (arr) => { const S7 = STRATS['S7 미반영+저변동+유동성 복합']; const d = arr.filter((r) => !r.isLargeCap); const sc = S7.score(d); return d.filter(S7.filter).sort((a, b) => sc(b) - sc(a)).slice(0, 5); },
  },
  'C 구조 Discovery 5 (S7C, WHAT CHANGED 필수)': {
    pick: (arr) => { const S = STRATS['S7C S7 + WHAT CHANGED 존재 (수급확인 또는 신선한 변화)']; const d = arr.filter((r) => !r.isLargeCap); const sc = S.score(d); return d.filter(S.filter).sort((a, b) => sc(b) - sc(a)).slice(0, 5); },
  },
  // 7차: 제품 목적(새 종목 발견)과의 절충 — 더 작은 종목으로 강제 / 반복 선정 금지
  ...Object.fromEntries([60, 100, 200].map((cut) => [`BX${cut} B 구조, 시총 상위 ${cut} 제외`, {
    pick: (arr) => {
      const S7 = STRATS['S7 미반영+저변동+유동성 복합'];
      const d = arr.filter((r) => r.capRank > cut);
      const sc = S7.score(d);
      return d.filter(S7.filter).sort((a, b) => sc(b) - sc(a)).slice(0, 5);
    },
  }])),
  'N v0.2식 Novelty 점수 상위 (Discovery)': {
    pick: (arr) => arr.filter((r) => !r.isLargeCap && r.novelty != null).sort((a, b) => b.novelty - a.novelty).slice(0, 5),
  },
  // 6차: B 구조 민감도 — 가중치 [미반영, 변화후수익, 변동성, 유동성]
  ...Object.fromEntries([[1, 1, 1, 0.5], [1, 1, 1, 0], [1, 1, 0.5, 0.5], [1, 0.5, 1, 0.5], [0.5, 1, 1, 0.5], [1, 1, 1.5, 0.5], [1, 1, 1, 1]].map((w) => [
    `W ${w.join('/')}`,
    {
      pick: (arr) => {
        const d = arr.filter((r) => !r.isLargeCap && r.pricedIn !== 'likely_priced_in' && r.pricedIn !== 'partially_priced_in');
        const a = zmap(d, (r) => PRICED[r.pricedIn] ?? 0), s = zmap(d, (r) => r.signalReturn ?? r.r20), v = zmap(d, (r) => r.atrPct), l = zmap(d, (r) => (r.tradVal20 ? Math.log(r.tradVal20) : null));
        const sc = (r) => w[0] * a(r) - w[1] * s(r) - w[2] * v(r) + w[3] * l(r);
        return d.sort((x, y) => sc(y) - sc(x)).slice(0, K);
      },
    },
  ])),
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
    } else if (strat.pick) {
      picks = strat.pick(noRepeat ? arr.filter((r) => !(last.has(r.symbol) && dayN - last.get(r.symbol) < 5)) : arr);
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
  const list = [...(enginePicks.size ? [['ENGINE v0.2 실제 선정', 'ENGINE']] : []), ...Object.entries(STRATS)]
    .filter(([name]) => !STRATS_ONLY || [...STRATS_ONLY].some((k) => name.startsWith(k)));
  for (const [name, s] of list) {
    for (const nr of s === 'ENGINE' ? [false] : [false, true]) {
      const r = run(name, s, P.from, P.to, nr);
      console.log(`${(name + (nr ? ' +반복금지' : '')).slice(0, 33).padEnd(34)}${String(r.days).padStart(3)} ${String(r.n).padStart(5)}  ${f(r.winRate)}  ${f(r.winNet)}  ${f(r.mean, 2)}   ${f(r.beatPool)}   ${f(r.meanEx, 2)} ${r.ci.padEnd(16)} ${f(r.portWin)}   ${f(r.portBeat)}`);
    }
  }
}
