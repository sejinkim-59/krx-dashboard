// 패널 위에서 Factor/Feature 예측력 분석.
// 각 날짜마다 후보 종목들의 Feature 값과 선행 초과수익(후보풀 평균 대비)의 순위상관(rank IC)을 구하고
// 날짜 평균 IC, t-stat, 상위/하위 20% 수익 차이를 본다.
// 사용: node scripts/bt-analyze.mjs <panel.json> [horizon=5] [fromDate] [toDate] [filter: all|discovery|large]

import { readFile } from 'node:fs/promises';
import { rankIC, basicStats } from './lib/backtest-core.mjs';

const [file, hArg, from, to, filt = 'all'] = process.argv.slice(2);
const h = Number(hArg || 5);
const panel = JSON.parse(await readFile(file, 'utf-8'));
const inRange = (d) => (!from || d >= from) && (!to || d <= to);
let rows = panel.rows.filter((r) => inRange(r.date) && r.fwd[h] != null);
if (filt === 'discovery') rows = rows.filter((r) => !r.isLargeCap);
if (filt === 'large') rows = rows.filter((r) => r.isLargeCap);

const byDate = new Map();
for (const r of rows) { if (!byDate.has(r.date)) byDate.set(r.date, []); byDate.get(r.date).push(r); }
for (const arr of byDate.values()) {
  const m = arr.reduce((s, r) => s + r.fwd[h], 0) / arr.length;
  for (const r of arr) r.ex = r.fwd[h] - m;
}

const FEATURES = {
  score: (r) => r.score, discoveryScore: (r) => r.discoveryScore,
  novelty: (r) => r.novelty, catalyst: (r) => r.catalyst, technical: (r) => r.technical, flow: (r) => r.flow, rs: (r) => r.rs,
  groups: (r) => r.groups, newSignals: (r) => r.newSignals,
  flowPct: (r) => r.flowPct, flowCapIntensity: (r) => r.flowCapIntensity, dirFlip: (r) => r.dirFlip, retailFlip: (r) => r.retailFlip,
  flowBullish: (r) => (r.flowInterp === 'bullish' ? 1 : r.flowInterp === 'bearish' ? -1 : 0),
  r5: (r) => r.r5, r20: (r) => r.r20, r60: (r) => r.r60, dHigh52: (r) => r.dHigh52, dHigh20: (r) => r.dHigh20,
  volRatio: (r) => r.volRatio, rsi: (r) => r.rsi, atrPct: (r) => r.atrPct, ma20Gap: (r) => r.ma20Gap, ma60Gap: (r) => r.ma60Gap,
  signalReturn: (r) => r.signalReturn,
  evPriceCrossFresh: (r) => (r.evPriceCross != null && r.evPriceCross <= 5 ? 1 : 0),
  evMaCrossFresh: (r) => (r.evMaCross != null && r.evMaCross <= 5 ? 1 : 0),
  evVolSpikeFresh: (r) => (r.evVolSpike != null && r.evVolSpike <= 5 ? 1 : 0),
  notPriced: (r) => ({ not_yet_priced: 2, unclear: 1, partially_priced_in: -1, likely_priced_in: -2 }[r.pricedIn] ?? 0),
  logTradVal: (r) => (r.tradVal20 ? Math.log(r.tradVal20) : null),
  smallCap: (r) => (r.capRank != null ? r.capRank : null),
};

const out = [];
for (const [name, fn] of Object.entries(FEATURES)) {
  const ics = [], spreads = [];
  for (const arr of byDate.values()) {
    const xs = arr.map(fn), ys = arr.map((r) => r.ex);
    const ic = rankIC(xs, ys);
    if (ic != null) ics.push(ic);
    const valid = arr.filter((r) => fn(r) != null).sort((a, b) => fn(a) - fn(b));
    if (valid.length >= 10) {
      const q = Math.floor(valid.length / 5);
      const lo = valid.slice(0, q), hi = valid.slice(-q);
      spreads.push(hi.reduce((s, r) => s + r.ex, 0) / hi.length - lo.reduce((s, r) => s + r.ex, 0) / lo.length);
    }
  }
  const s = basicStats(ics);
  const sp = basicStats(spreads);
  out.push({ name, days: s.n, meanIC: s.mean, t: s.n > 1 ? (s.mean / (s.sd / Math.sqrt(s.n))) : null, icPosDays: s.winRate, q5minusQ1: sp.mean });
}
out.sort((a, b) => Math.abs(b.t ?? 0) - Math.abs(a.t ?? 0));
const f = (x, d = 3) => (x == null || !Number.isFinite(x) ? '   -  ' : (x >= 0 ? ' ' : '') + x.toFixed(d));
console.log(`horizon D+${h} | ${byDate.size}일 | ${rows.length}행 | filter=${filt} | 기간 ${from || 'start'}~${to || 'end'}`);
console.log('feature              meanIC     t     IC>0일%  Q5-Q1(%p)');
for (const r of out) console.log(`${r.name.padEnd(18)} ${f(r.meanIC)} ${f(r.t, 2)}   ${f(r.icPosDays, 0)}   ${f(r.q5minusQ1, 2)}`);
