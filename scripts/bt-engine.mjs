// 전체 엔진(수급·공시·가격 모두 사용)을 Profile별로 같은 point-in-time 데이터 위에서 돌려 비교한다.
// 사용: node scripts/bt-engine.mjs <firstDate> [lastDate] [profiles=v0.2,v0.3]
// 결과: data/backtest-engine-<first>-<last>.json + 콘솔 요약

import { writeJson } from './lib/util.mjs';
import { loadDataset, buildDay, fwdReturn, benchReturns, poolReturns, basicStats, bootstrapByDay, HORIZONS, ROUND_TRIP_COST_PCT } from './lib/backtest-core.mjs';
import { runSelectionEngine } from './lib/selection-engine.mjs';
import { applyProfile } from './lib/selection-config.mjs';

const firstDate = process.argv[2] || '20260827';
const lastDate = process.argv[3] && process.argv[3] !== '-' ? process.argv[3] : null;
const profiles = (process.argv[4] || 'v0.2,v0.3').split(',');
const ds = await loadDataset({ firstDate, lastDate, krxDelayMs: Number(process.env.BT_KRX_DELAY || 250) });

// 입력 재구성은 profile과 무관하므로 한 번만
const inputs = [];
for (let i = ds.firstIdx; i <= ds.lastIdx; i++) {
  const day = buildDay(ds, i);
  inputs.push({ ...day, i, bench: benchReturns(ds, i), pool: poolReturns(ds, i, day.pool) });
}

const results = {};
for (const prof of profiles) {
  applyProfile(prof);
  const recent = new Map(); // symbol -> 선정 후 경과 거래일
  const days = [];
  for (const inp of inputs) {
    for (const [s, n] of recent) recent.set(s, n + 1);
    const r = runSelectionEngine(inp.d, inp.T, 'Neutral', inp.today, { recentPicks: recent });
    for (const p of r.finalPicks) recent.set(p.symbol, 0);
    days.push({
      date: inp.T, bench: inp.bench, pool: inp.pool,
      picks: r.finalPicks.map((p) => ({ symbol: p.symbol, name: p.company, bucket: p.bucket, score: p.score, pricedIn: p.pricedIn.verdict,
        ret: Object.fromEntries(HORIZONS.map((h) => [h, fwdReturn(ds.barsBy[p.symbol], ds.cal, inp.i, h)])) })),
    });
  }
  const summary = {};
  for (const h of HORIZONS) {
    const dRaw = [], dExPool = [], dExK = [];
    const byBucket = {};
    for (const d of days) {
      const ps = d.picks.filter((p) => p.ret[h] != null);
      if (!ps.length) continue;
      dRaw.push(ps.map((p) => p.ret[h]));
      if (d.pool[h] != null) dExPool.push(ps.map((p) => p.ret[h] - d.pool[h]));
      if (d.bench['069500'][h] != null) dExK.push(ps.map((p) => p.ret[h] - d.bench['069500'][h]));
      for (const p of ps) (byBucket[p.bucket] ||= []).push(p.ret[h]);
    }
    const raw = dRaw.flat();
    const port = dRaw.map((v) => v.reduce((a, b) => a + b, 0) / v.length);
    const portK = dExK.map((v) => v.reduce((a, b) => a + b, 0) / v.length);
    summary[`D+${h}`] = {
      picks: raw.length, days: dRaw.length,
      winRate: basicStats(raw).winRate, winRateNet: raw.length ? (raw.filter((x) => x - ROUND_TRIP_COST_PCT > 0).length / raw.length) * 100 : null,
      mean: basicStats(raw).mean, median: basicStats(raw).median,
      beatKospi200: basicStats(dExK.flat()).winRate, meanExKospi200: basicStats(dExK.flat()).mean, ciExKospi200: bootstrapByDay(dExK),
      beatPool: basicStats(dExPool.flat()).winRate, meanExPool: basicStats(dExPool.flat()).mean, ciExPool: bootstrapByDay(dExPool),
      portfolioWinDays: basicStats(port).winRate, portfolioBeatKospiDays: basicStats(portK).winRate,
      byBucket: Object.fromEntries(Object.entries(byBucket).map(([b, v]) => [b, { n: v.length, winRate: basicStats(v).winRate, mean: basicStats(v).mean }])),
    };
  }
  results[prof] = { summary, days };
}

const tag = `${ds.cal[ds.firstIdx]}-${ds.cal[ds.lastIdx]}`;
await writeJson(`backtest-engine-${tag}.json`, { generated_at: new Date().toISOString(), period: tag, profiles, costRoundTripPct: ROUND_TRIP_COST_PCT, results });

const f = (x, d = 1) => (x == null || !Number.isFinite(x) ? '-' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}`);
const ci = (c) => (c ? `[${f(c.lo, 2)}, ${f(c.hi, 2)}]` : '');
for (const h of HORIZONS) {
  console.log(`\n==== D+${h} (${tag}) ====`);
  for (const prof of profiles) {
    const s = results[prof].summary[`D+${h}`];
    console.log(`${prof.padEnd(5)} ${s.picks}건/${s.days}일 | 승률 ${f(s.winRate)}% (비용후 ${f(s.winRateNet)}%) | 평균 ${f(s.mean, 2)}% 중앙 ${f(s.median, 2)}% | KOSPI200초과율 ${f(s.beatKospi200)}% 평균 ${f(s.meanExKospi200, 2)}%p ${ci(s.ciExKospi200)} | 풀초과율 ${f(s.beatPool)}% 평균 ${f(s.meanExPool, 2)}%p ${ci(s.ciExPool)} | 포트 수익일 ${f(s.portfolioWinDays)}%`);
    for (const [b, x] of Object.entries(s.byBucket)) console.log(`      ${b.padEnd(14)} ${x.n}건 승률 ${f(x.winRate)}% 평균 ${f(x.mean, 2)}%`);
  }
}
