// 전종목 일별 시세(KRX Open API) → 종목별 수정주가 봉 + 날짜별 Feature 행.
// 백테스트(bt-market-panel)와 운영(v0.5 선정)이 같은 함수를 써서 결과가 일치하도록 한 곳에 둔다.

import { computeFeatures, detectChangeEvents } from './technical.mjs';
import { evalNovelty } from './novelty.mjs';
import { evalPricedIn } from './context.mjs';

export const EXCLUDE_NAME = /스팩|제\d+호|리츠|우$|우B$|우\(전환\)$|ETN|ETF|인프라|펀드/;
export const MIN_TRADING_VALUE_20D = 5e9;

/**
 * days: [{date:'YYYYMMDD', data:{code:[o,h,l,c,vol,val,mcap,shares,name,mkt]}}] 날짜 오름차순.
 * KRX 가격은 수정주가가 아니므로 상장주식수 급변 + 가격 역방향 변화를 분할·무상증자로 보고 과거 가격을 조정한다.
 */
export function buildAdjustedBars(days) {
  const cal = days.map((d) => d.date);
  const series = new Map(), names = new Map();
  days.forEach((d, t) => {
    for (const [s, v] of Object.entries(d.data)) {
      if (!series.has(s)) series.set(s, new Array(cal.length).fill(null));
      series.get(s)[t] = v;
      names.set(s, v[8]);
    }
  });
  const barsBy = new Map();
  let adjEvents = 0;
  for (const [s, arr] of series) {
    if (EXCLUDE_NAME.test(names.get(s) || '')) continue;
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
    barsBy.set(s, arr.map((v, t) => {
      if (!v || !v[3] || !v[4]) return null;
      const k = factor[t];
      return { time: cal[t], open: (v[0] || v[3]) * k, high: v[1] * k, low: v[2] * k, close: v[3] * k, volume: v[4] / k, value: v[5], mcap: v[6] };
    }));
  }
  return { cal, barsBy, names, adjEvents };
}

/** 날짜 인덱스 t 시점(그날 장마감까지의 정보만)의 유동성 통과 종목 Feature 행 */
export function featureRowsAt(t, { cal, barsBy, names }) {
  const caps = [], rows = [];
  for (const [s, bars] of barsBy) {
    if (!bars[t]) continue;
    const hist = bars.slice(0, t + 1).filter(Boolean);
    if (hist.length < 65) continue;
    const tv20 = hist.slice(-20).reduce((a, b) => a + b.value, 0) / 20;
    caps.push([s, bars[t].mcap]);
    if (tv20 < MIN_TRADING_VALUE_20D) continue;
    const yr = hist.slice(-250);
    const f = computeFeatures(hist, Math.max(...yr.map((b) => b.high)));
    if (!f) continue;
    const ce = detectChangeEvents(hist, 2.0);
    const nov = evalNovelty(ce, null);
    const pi = evalPricedIn(f, hist, nov, null);
    const ev = Object.fromEntries((nov.events || []).map((e) => [e.id, e.daysSinceChange]));
    rows.push({
      date: cal[t], symbol: s, name: names.get(s), mcap: bars[t].mcap, close: f.close,
      novelty: nov.available ? nov.score / nov.availableWeight : null, noveltyEvents: nov.activeEvents || [],
      pricedIn: pi.verdict, pricedInLines: pi.lines, signalReturn: pi.signalReturn ?? null,
      r5: f.return5D, r20: f.return20D, r60: f.return60D, dHigh52: f.dist52WHigh, dHigh20: f.dist20DHigh,
      volRatio: f.volumeRatio, rsi: f.rsi14, atrPct: f.atr14 ? (f.atr14 / f.close) * 100 : null,
      ma20: f.ma20, ma60: f.ma60,
      ma20Gap: f.ma20 ? ((f.close - f.ma20) / f.ma20) * 100 : null, ma60Gap: f.ma60 ? ((f.close - f.ma60) / f.ma60) * 100 : null,
      ma20Slope: f.ma20Slope,
      evPriceCross: ev.priceCrossAboveMa20 ?? null, evMaCross: ev.ma20CrossAboveMa60 ?? null, evVolSpike: ev.volumeSpike ?? null,
      tradVal20: tv20,
    });
  }
  caps.sort((a, b) => b[1] - a[1]);
  const rank = new Map(caps.map(([s], i) => [s, i + 1]));
  for (const r of rows) { r.capRank = rank.get(r.symbol); r.isLargeCap = r.capRank <= 30; }
  return rows;
}
