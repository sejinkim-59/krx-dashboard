// 전종목(선택 편향 없음) 가격 패널. 유니버스 = 그날 상장된 보통주 중 20일 평균 거래대금 50억 이상.
// KRX Open API 가격은 수정주가가 아니므로 상장주식수 변화로 액면분할·무상증자를 감지해 과거 가격을 조정한다.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CACHE, HORIZONS } from './lib/backtest-core.mjs';
import { computeFeatures, detectChangeEvents } from './lib/technical.mjs';
import { evalNovelty } from './lib/novelty.mjs';
import { evalPricedIn } from './lib/context.mjs';

const EXCLUDE = /스팩|제\d+호|리츠|우$|우B$|우\(전환\)$|ETN|ETF|인프라|펀드/;
const files = (await readdir(CACHE)).filter((f) => /^mkt-\d{8}\.json$/.test(f)).sort();
const cal = files.map((f) => f.slice(4, 12));
console.log(`[mkt-panel] ${cal[0]}~${cal[cal.length - 1]} ${cal.length}일`);

// symbol -> 날짜 인덱스별 raw 배열
const series = new Map();
const names = new Map();
for (let t = 0; t < cal.length; t++) {
  const day = JSON.parse(await readFile(path.join(CACHE, files[t]), 'utf-8'));
  for (const [s, v] of Object.entries(day)) {
    if (!series.has(s)) series.set(s, new Array(cal.length).fill(null));
    series.get(s)[t] = v;
    names.set(s, v[8]);
  }
}

// 분할·무상증자 조정 + 봉 배열 생성
let adjEvents = 0;
const barsBy = new Map();
for (const [s, arr] of series) {
  if (EXCLUDE.test(names.get(s) || '')) continue;
  const factor = new Array(cal.length).fill(1);
  let f = 1;
  for (let t = cal.length - 1; t >= 1; t--) {
    factor[t] = f;
    const cur = arr[t], prev = arr[t - 1];
    if (cur && prev && prev[7] > 0 && prev[3] > 0 && cur[3] > 0) {
      const r = cur[7] / prev[7], pr = cur[3] / prev[3];
      if ((r > 1.05 || r < 0.95) && pr * r > 0.7 && pr * r < 1.4) { f /= r; adjEvents++; }
    }
  }
  factor[0] = f;
  const bars = [];
  for (let t = 0; t < cal.length; t++) {
    const v = arr[t];
    if (!v || !v[3] || !v[4]) { bars.push(null); continue; } // 거래 없음(정지 등)
    const k = factor[t];
    bars.push({ time: cal[t], open: (v[0] || v[3]) * k, high: v[1] * k, low: v[2] * k, close: v[3] * k, volume: v[4] / k, value: v[5], mcap: v[6] });
  }
  barsBy.set(s, bars);
}
console.log(`[mkt-panel] 종목 ${barsBy.size}, 분할/무상 조정 ${adjEvents}건`);

function fwd(bars, t, h) {
  const e = bars[t + 1], x = bars[t + h];
  if (!e || !x || !e.open) return null;
  return ((x.close - e.open) / e.open) * 100;
}

const rows = [];
for (let t = 70; t < cal.length - HORIZONS[0]; t++) {
  const caps = [];
  const dayRows = [];
  for (const [s, bars] of barsBy) {
    if (!bars[t]) continue;
    const hist = bars.slice(0, t + 1).filter(Boolean);
    if (hist.length < 65) continue;
    const last20 = hist.slice(-20);
    const tv20 = last20.reduce((a, b) => a + b.value, 0) / 20;
    caps.push([s, bars[t].mcap]);
    if (tv20 < 5e9) continue;
    const yr = hist.slice(-250);
    const f = computeFeatures(hist, Math.max(...yr.map((b) => b.high)));
    if (!f) continue;
    const ce = detectChangeEvents(hist, 2.0);
    const nov = evalNovelty(ce, null);
    const pi = evalPricedIn(f, hist, nov, null);
    const ev = Object.fromEntries((nov.events || []).map((e) => [e.id, e.daysSinceChange]));
    dayRows.push({
      date: cal[t], symbol: s, name: names.get(s), mcap: bars[t].mcap,
      novelty: nov.available ? nov.score / nov.availableWeight : null,
      pricedIn: pi.verdict, signalReturn: pi.signalReturn ?? null,
      r5: f.return5D, r20: f.return20D, r60: f.return60D, dHigh52: f.dist52WHigh, dHigh20: f.dist20DHigh,
      volRatio: f.volumeRatio, rsi: f.rsi14, atrPct: f.atr14 ? (f.atr14 / f.close) * 100 : null,
      ma20Gap: f.ma20 ? ((f.close - f.ma20) / f.ma20) * 100 : null, ma60Gap: f.ma60 ? ((f.close - f.ma60) / f.ma60) * 100 : null,
      ma20Slope: f.ma20Slope,
      evPriceCross: ev.priceCrossAboveMa20 ?? null, evMaCross: ev.ma20CrossAboveMa60 ?? null, evVolSpike: ev.volumeSpike ?? null,
      tradVal20: tv20,
      fwd: Object.fromEntries(HORIZONS.map((h) => [h, fwd(bars, t, h)])),
    });
  }
  caps.sort((a, b) => b[1] - a[1]);
  const rank = new Map(caps.map(([s], i) => [s, i + 1]));
  for (const r of dayRows) { r.capRank = rank.get(r.symbol); r.isLargeCap = r.capRank <= 30; }
  rows.push(...dayRows);
  if (t % 20 === 0) console.log(`[mkt-panel] ${cal[t]} 유동성 통과 ${dayRows.length}종목`);
}
await writeFile(path.join(CACHE, 'market-panel.json'), JSON.stringify({ rows }));
console.log(`[mkt-panel] 저장 ${rows.length}행`);
