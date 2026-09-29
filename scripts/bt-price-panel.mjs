// 가격 전용 장기 패널 — 수급(KRX) 이력이 없는 기간에도 가격 기반 요소(Novelty·Priced-in·Technical·반전/추세)의
// 예측력이 시간에 따라 유지되는지 확인한다.
// 주의(선택 편향): 종목 집합은 캐시된 종목(관심종목 + 2026-08/09 pre-screen 종목)이다. 즉 "나중에 주목받은 종목"으로
// 조건이 걸려 있어 절대 수익률은 과대평가될 수 있다. 여기서는 같은 날 종목 간 상대 순위(IC)만 본다.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CACHE, ymd, fwdReturn, HORIZONS } from './lib/backtest-core.mjs';
import { computeFeatures, detectChangeEvents } from './lib/technical.mjs';
import { evalNovelty } from './lib/novelty.mjs';
import { evalPricedIn } from './lib/context.mjs';
import { WATCHLIST } from './lib/kis-watchlist.mjs';

const files = (await readdir(CACHE)).filter((f) => f.startsWith('bars-'));
const barsBy = {};
for (const f of files) barsBy[f.slice(5, -5)] = JSON.parse(await readFile(path.join(CACHE, f), 'utf-8'));
const cal = barsBy['069500'].map((b) => ymd(b.time));
const watch = new Set(WATCHLIST.map((w) => w.symbol));
const symbols = Object.keys(barsBy).filter((s) => !['069500', '229200'].includes(s));
console.log(`[price-panel] 종목 ${symbols.length}, 달력 ${cal[0]}~${cal[cal.length - 1]}`);

const idxBy = {};
for (const s of symbols) idxBy[s] = new Map(barsBy[s].map((b, i) => [ymd(b.time), i]));

const rows = [];
for (let i = 70; i < cal.length - HORIZONS[0]; i++) {
  const T = cal[i];
  const dayRows = [];
  for (const s of symbols) {
    const j = idxBy[s].get(T);
    if (j == null || j < 64) continue;
    const bars = barsBy[s].slice(0, j + 1);
    const yr = bars.slice(-250);
    const f = computeFeatures(bars, Math.max(...yr.map((b) => b.high)));
    if (!f) continue;
    const tv20 = bars.slice(-20).reduce((a, b) => a + b.close * b.volume, 0) / 20;
    if (tv20 < 5e9) continue; // production과 같은 유동성 필터
    const ce = detectChangeEvents(bars, 2.0);
    const nov = evalNovelty(ce, null);
    const pi = evalPricedIn(f, bars, nov, null);
    const ev = Object.fromEntries((nov.events || []).map((e) => [e.id, e.daysSinceChange]));
    dayRows.push({
      date: T, symbol: s, watch: watch.has(s),
      novelty: nov.available ? nov.score / nov.availableWeight : null,
      pricedIn: pi.verdict, signalReturn: pi.signalReturn ?? null,
      r5: f.return5D, r20: f.return20D, r60: f.return60D, dHigh52: f.dist52WHigh, dHigh20: f.dist20DHigh,
      volRatio: f.volumeRatio, rsi: f.rsi14, atrPct: f.atr14 ? (f.atr14 / f.close) * 100 : null,
      ma20Gap: f.ma20 ? ((f.close - f.ma20) / f.ma20) * 100 : null, ma60Gap: f.ma60 ? ((f.close - f.ma60) / f.ma60) * 100 : null,
      ma20Slope: f.ma20Slope,
      evPriceCross: ev.priceCrossAboveMa20 ?? null, evMaCross: ev.ma20CrossAboveMa60 ?? null, evVolSpike: ev.volumeSpike ?? null,
      tradVal20: tv20,
      fwd: Object.fromEntries(HORIZONS.map((h) => [h, fwdReturn(barsBy[s], cal, i, h)])),
    });
  }
  rows.push(...dayRows);
  if (i % 20 === 0) console.log(`[price-panel] ${T} ${dayRows.length}종목`);
}
const out = path.join(CACHE, 'price-panel.json');
await writeFile(out, JSON.stringify({ rows }));
console.log(`[price-panel] 저장 ${rows.length}행`);
