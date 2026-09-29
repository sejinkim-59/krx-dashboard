// 전종목 가격 패널 + 종목별 수급(네이버, 외국인/기관/개인) → production Flow 로직과 같은 규칙으로 수급 Feature 생성.
// 핵심 질문: "외국인/기관 수급 확인(Confirmation)"이 실제로 선행 수익률을 개선하는가?

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CACHE } from './lib/backtest-core.mjs';

const panel = JSON.parse(await readFile(path.join(CACHE, 'market-panel.json'), 'utf-8'));
const flowBy = new Map();
async function flowOf(s) {
  if (flowBy.has(s)) return flowBy.get(s);
  let v = null;
  try {
    const arr = JSON.parse(await readFile(path.join(CACHE, `nflow-${s}.json`), 'utf-8'));
    v = { arr, idx: new Map(arr.map((r, i) => [r[0], i])) };
  } catch { /* 없음 */ }
  flowBy.set(s, v);
  return v;
}

const byDate = new Map();
let withFlow = 0;
for (const r of panel.rows) {
  const fl = await flowOf(r.symbol);
  const i = fl?.idx.get(r.date);
  if (i == null || i < 8) continue;
  const val = (k, j) => fl.arr[j][k] * fl.arr[j][4]; // 수량 × 종가 = 금액 근사
  const sum = (k, a, b) => { let s = 0; for (let j = a; j <= b; j++) s += val(k, j); return s; };
  const recent = { f: sum(1, i - 2, i), o: sum(2, i - 2, i), p: sum(3, i - 2, i) };
  const prior = { f: sum(1, i - 7, i - 3), o: sum(2, i - 7, i - 3), p: sum(3, i - 7, i - 3) };
  const flip = (k) => (prior[k] < 0 && recent[k] > 0 ? 1 : prior[k] > 0 && recent[k] < 0 ? -1 : 0);
  const ff = flip('f'), fo = flip('o'), fp = flip('p');
  const conflicting = ff !== 0 && fo !== 0 && ff !== fo;
  const dir = ff !== 0 ? ff : fo; // 외국인 우선
  let interp = 'neutral';
  if (conflicting) interp = 'conflicting';
  else if (dir !== 0) {
    const priceOk = r.r5 != null && (dir > 0 ? r.r5 > 0 : r.r5 < 0);
    const volOk = r.volRatio != null && r.volRatio >= 1.3;
    if (priceOk || volOk) interp = dir > 0 ? 'bullish' : 'bearish';
  }
  Object.assign(r, {
    fFlip: ff, oFlip: fo, pFlip: fp, dirNet3: recent.f + recent.o,
    capInt: r.mcap ? (recent.f + recent.o) / r.mcap : null,
    fNet3Int: r.mcap ? recent.f / r.mcap : null, oNet3Int: r.mcap ? recent.o / r.mcap : null, pNet3Int: r.mcap ? recent.p / r.mcap : null,
    flowInterp: interp,
    // 20일 누적 외국인+기관 순매수 강도 (더 긴 창)
    dirNet20Int: r.mcap && i >= 20 ? (sum(1, i - 19, i) + sum(2, i - 19, i)) / r.mcap : null,
  });
  withFlow++;
  if (!byDate.has(r.date)) byDate.set(r.date, []);
  byDate.get(r.date).push(r);
}
// 날짜 내 percentile + production식 Flow 점수 근사 (전환확인 7 + 강도 상위10% 5 + 순매수 상위 & 가격 하락 없음 3)
for (const arr of byDate.values()) {
  const sorted = arr.filter((r) => r.capInt != null).sort((a, b) => a.capInt - b.capInt);
  sorted.forEach((r, k) => { r.capIntPct = sorted.length > 1 ? (k / (sorted.length - 1)) * 100 : 50; });
  const topNet = new Set([...arr].sort((a, b) => b.dirNet3 - a.dirNet3).slice(0, 20).map((r) => r.symbol));
  for (const r of arr) {
    const s = (r.flowInterp === 'bullish' ? 7 : 0) + (r.dirNet3 > 0 && r.capIntPct >= 90 ? 5 : 0) + (topNet.has(r.symbol) && (r.r5 ?? 0) >= 0 ? 3 : 0);
    r.flow = s / 15;
    r.flowBullish = r.flowInterp === 'bullish' ? 1 : r.flowInterp === 'bearish' ? -1 : 0;
  }
}
const rows = [...byDate.values()].flat();
await writeFile(path.join(CACHE, 'flow-panel.json'), JSON.stringify({ rows }));
console.log(`[flow-panel] 가격 패널 ${panel.rows.length}행 중 수급 결합 ${withFlow}행, 날짜 ${byDate.size}`);
