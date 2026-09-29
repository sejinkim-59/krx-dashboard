// 백테스트 패널 생성: 날짜 × (가격 데이터가 있는) 후보 종목마다 Factor 점수·원시 Feature·실제 선행수익률을 기록.
// 전략 비교/Factor 예측력(IC) 분석은 이 패널 위에서 빠르게 반복한다.
// 사용: node scripts/bt-panel.mjs [firstDate YYYYMMDD] [lastDate]

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadDataset, buildDay, fwdReturn, benchReturns, poolReturns, HORIZONS, CACHE } from './lib/backtest-core.mjs';
import { evaluateCandidates, runSelectionEngine } from './lib/selection-engine.mjs';

const firstDate = process.argv[2] || '20260827';
const lastDate = process.argv[3] || null;
const krxDelayMs = Number(process.env.BT_KRX_DELAY || 250);

const ds = await loadDataset({ firstDate, lastDate, krxDelayMs });
const rows = [], days = [];
for (let i = ds.firstIdx; i <= ds.lastIdx; i++) {
  const { T, d, today, pool } = buildDay(ds, i);
  const { candidates } = evaluateCandidates(d, today);
  const engine = runSelectionEngine(d, T, 'Neutral', today);
  const bench = benchReturns(ds, i), poolRet = poolReturns(ds, i, pool);
  days.push({
    date: T, idx: i, poolSize: pool.length, bench, pool: poolRet,
    picks: engine.finalPicks.map((p) => ({ symbol: p.symbol, name: p.company, bucket: p.bucket })),
  });
  for (const c of candidates) {
    if (!c.features) continue;
    const f = c.features, fl = c.factors.flow;
    const ev = Object.fromEntries((c.factors.novelty.events || []).map((e) => [e.id, e.daysSinceChange ?? null]));
    const sc = (x) => (x.available ? x.score / x.availableWeight : null);
    rows.push({
      date: T, idx: i, symbol: c.symbol, name: c.name, capRank: c.capRank, isLargeCap: c.isLargeCap,
      discovery: !!ds.enrichBy[T].find((p) => p.symbol === c.symbol),
      score: c.normalizedScore, discoveryScore: c.discoveryScore, coverage: c.dataCoverage,
      groups: c.groups.length, sources: c.sources.size, newSignals: c.newSignalCount, gateBase: c.gate.base, answerable: c.gate.answerable,
      novelty: sc(c.factors.novelty), catalyst: sc(c.factors.catalyst), corporate: sc(c.factors.corporate),
      technical: sc(c.factors.technical), flow: sc(fl), rs: sc(c.factors.relativeStrength),
      flowInterp: fl.interpretation, flowPct: fl.intensity?.percentile ?? null, flowCapIntensity: fl.intensity?.capIntensity ?? null,
      retailFlip: fl.retailFlip ? (fl.retailFlip.toBuy ? 1 : -1) : 0,
      dirFlip: fl.directionalFlip ? (fl.directionalFlip.toBuy ? 1 : -1) : 0,
      evMaCross: ev.ma20CrossAboveMa60 ?? null, evPriceCross: ev.priceCrossAboveMa20 ?? null, evVolSpike: ev.volumeSpike ?? null,
      pricedIn: c.pricedIn.verdict, signalReturn: c.pricedIn.signalReturn ?? null,
      r5: f.return5D, r20: f.return20D, r60: f.return60D, dHigh52: f.dist52WHigh, dHigh20: f.dist20DHigh,
      volRatio: f.volumeRatio, rsi: f.rsi14, atrPct: f.atr14 && f.close ? (f.atr14 / f.close) * 100 : null,
      ma20Gap: f.ma20 ? ((f.close - f.ma20) / f.ma20) * 100 : null, ma60Gap: f.ma60 ? ((f.close - f.ma60) / f.ma60) * 100 : null,
      liqOk: c.liquidityOk, tradVal20: f.avgTradingValue20D,
      risk: c.risk.decision,
      fwd: Object.fromEntries(HORIZONS.map((h) => [h, fwdReturn(ds.barsBy[c.symbol], ds.cal, i, h)])),
    });
  }
  if ((i - ds.firstIdx) % 10 === 0) console.log(`[panel] ${T} 후보 ${candidates.filter((c) => c.features).length} picks ${engine.finalPicks.map((p) => p.company).join(',')}`);
}
const file = path.join(CACHE, `panel-${ds.cal[ds.firstIdx]}-${ds.cal[ds.lastIdx]}.json`);
await writeFile(file, JSON.stringify({ firstDate: ds.cal[ds.firstIdx], lastDate: ds.cal[ds.lastIdx], failed: ds.failed, days, rows }));
console.log(`[panel] 저장 ${file} — ${days.length}일, ${rows.length}행`);
