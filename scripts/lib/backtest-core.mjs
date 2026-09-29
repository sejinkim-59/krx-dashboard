// Point-in-time 백테스트 공용 코어 — 데이터 적재(캐시)와 전략 평가를 분리한다.
// 각 날짜 T에는 T 장마감까지 알 수 있었던 데이터만 사용한다 (look-ahead 금지).
//  수급: KRX 일별 전종목 순매수를 받아 T 기준 3일/5일 창을 재합산
//  공시: DART를 T 기준 production과 같은 lookback으로 필터
//  가격: KIS 일봉을 T까지 절단, 시총은 현재 상장주식수 × T 종가 근사
//  Discovery 조회 대상: T 시점 pre-screen으로 재선정
//  진입 T+1 시가, 청산 T+h 종가

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sleep } from './util.mjs';
import { fetchQuote, fetchDailyOhlcv, normalizeQuote, normalizeOhlcv } from './kis.mjs';
import { fetchNetBuyTopByInvestorType } from './krx-public.mjs';
import { fetchAllDisclosures, fetchPiicDecsn, fetchFricDecsn, fetchCvbdIsDecsn, fetchTsstkAqDecsn, fetchTsstkDpDecsn } from './dart.mjs';
import { WATCHLIST } from './kis-watchlist.mjs';
import { buildUniverse } from './selection-engine.mjs';
import { preScreen, allocateEnrichment } from './discovery-enrich.mjs';

export const CACHE = path.join(process.cwd(), '.cache', 'backtest');
export const HORIZONS = [5, 10, 20];
export const ROUND_TRIP_COST_PCT = 0.3;
export const BENCH = { '069500': 'KODEX 200', '229200': 'KODEX 코스닥150' };
const INVESTORS = [
  { code: '9000', label: '외국인' }, { code: '7050', label: '기관합계' },
  { code: '6000', label: '연기금 등' }, { code: '8000', label: '개인' },
];

export const ymd = (s) => s.replace(/-/g, '');
const num = (v) => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isNaN(n) ? 0 : n; };
export function shiftDays(yyyymmdd, days) {
  const d = new Date(Number(yyyymmdd.slice(0, 4)), Number(yyyymmdd.slice(4, 6)) - 1, Number(yyyymmdd.slice(6, 8)) + days);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

async function cached(name, fn) {
  const file = path.join(CACHE, `${name}.json`);
  try { return JSON.parse(await readFile(file, 'utf-8')); } catch { /* miss */ }
  const v = await fn();
  await writeFile(file, JSON.stringify(v));
  return v;
}
export async function hasCache(name) {
  try { await readFile(path.join(CACHE, `${name}.json`)); return true; } catch { return false; }
}

/* ---------------- 원천 데이터 ---------------- */
export async function barsFor(symbol) {
  return cached(`bars-${symbol}`, async () => {
    let to = ymd(new Date().toISOString().slice(0, 10));
    const all = new Map();
    for (let page = 0; page < 3; page++) {
      const rows = normalizeOhlcv(await fetchDailyOhlcv(symbol, { from: shiftDays(to, -200), to }));
      await sleep(400);
      if (!rows.length) break;
      for (const b of rows) all.set(b.time, b);
      to = shiftDays(ymd(rows[0].time), -1);
    }
    return [...all.values()].sort((a, b) => a.time.localeCompare(b.time));
  });
}
export async function quoteFor(symbol, name) {
  return cached(`quote-${symbol}`, async () => {
    const o = await fetchQuote(symbol);
    await sleep(400);
    return normalizeQuote({ symbol, name }, o);
  });
}

/** KRX 일별 전종목 순매수. 요청이 몰리면 KRX가 에러 HTML을 주므로 길게 기다렸다 재시도. */
export async function dailyFlow(date, code, { delayMs = 250, maxWaitMin = 60 } = {}) {
  return cached(`flow-${date}-${code}`, async () => {
    const out = {};
    for (const mktId of ['STK', 'KSQ']) {
      let rows, waited = 0;
      for (let attempt = 1; ; attempt++) {
        try {
          rows = await fetchNetBuyTopByInvestorType({ mktId, invstTpCd: code, strtDd: date, endDd: date });
          break;
        } catch (e) {
          const wait = Math.min(5, attempt) * 60000;
          if (waited + wait > maxWaitMin * 60000) throw e;
          console.warn(`[bt] KRX 제한 추정 (${date} ${code} ${mktId}) — ${wait / 60000}분 대기`);
          await sleep(wait);
          waited += wait;
        }
      }
      for (const r of rows) out[r.ISU_SRT_CD] = { name: r.ISU_NM, net: num(r.NETBID_TRDVAL) };
      await sleep(delayMs);
    }
    return out;
  });
}

async function dartChunk(bgn, end) {
  return cached(`dart-${bgn}-${end}`, async () => {
    const all = await fetchAllDisclosures(bgn, end);
    const pick = (kw, ex = ['정정']) => all.filter((i) => i.report_nm.includes(kw) && !ex.some((e) => i.report_nm.includes(e)) && i.stock_code);
    const detail = async (items, fn, map) => {
      const out = [];
      for (const it of items) {
        let d = {};
        try { d = (await fn(it.corp_code, it.rcept_dt))[0] || {}; } catch { /* 상세 실패 → 기본 필드만 */ }
        out.push({ corp_name: it.corp_name, stock_code: it.stock_code, rcept_no: it.rcept_no, rcept_dt: it.rcept_dt, ...map(d) });
        await sleep(120);
      }
      return out;
    };
    const earningsSeen = new Map();
    for (const it of all) {
      if (!it.report_nm.includes('(잠정)실적(공정공시)') || it.report_nm.includes('정정') || !it.stock_code) continue;
      const key = it.stock_code + it.rcept_dt;
      if (!earningsSeen.has(key)) earningsSeen.set(key, { corp_name: it.corp_name, stock_code: it.stock_code, rcept_dt: it.rcept_dt });
    }
    return {
      capitalIncreasePaid: await detail(pick('유상증자결정'), fetchPiicDecsn, (d) => ({ method: d.ic_mthn || null, new_shares: d.nstk_ostk_cnt || null, record_date: d.nstk_asstd || null })),
      capitalIncreaseFree: await detail(pick('무상증자결정'), fetchFricDecsn, (d) => ({ record_date: d.nstk_asstd || null, ratio_per_share: d.nstk_ascnt_ps_ostk || null, listing_date: d.nstk_lstprd || null })),
      convertibleBond: await detail(pick('전환사채권발행결정'), fetchCvbdIsDecsn, (d) => ({ conversion_price: d.cv_prc || null, conversion_start: d.cvrqpd_bgd || null, conversion_end: d.cvrqpd_edd || null })),
      treasuryStock: [
        ...(await detail(pick('자기주식취득결정'), fetchTsstkAqDecsn, (d) => ({ type: '취득', period_start: d.aqexpd_bgd || null, period_end: d.aqexpd_edd || null, method: d.aq_mth || null }))),
        ...(await detail(pick('자기주식처분결정'), fetchTsstkDpDecsn, (d) => ({ type: '처분', period_start: d.dpprpd_bgd || null, period_end: d.dpprpd_edd || null, method: null }))),
      ],
      insiderPlan: pick('특정증권등거래계획보고서', []).map((it) => ({ corp_name: it.corp_name, stock_code: it.stock_code, rcept_no: it.rcept_no, rcept_dt: it.rcept_dt, flr_nm: it.flr_nm })),
      earnings: [...earningsSeen.values()],
    };
  });
}

/** DART list API는 기간 제한이 있어 ≤60일 단위로 나눠 받고 합친다. */
async function dartEvents(bgn, end) {
  const merged = { capitalIncreasePaid: [], capitalIncreaseFree: [], convertibleBond: [], treasuryStock: [], insiderPlan: [], earnings: [] };
  let s = bgn;
  while (s <= end) {
    const e = shiftDays(s, 59) < end ? shiftDays(s, 59) : end;
    const chunk = await dartChunk(s, e);
    for (const k of Object.keys(merged)) merged[k].push(...chunk[k]);
    s = shiftDays(e, 1);
  }
  return merged;
}

/* ---------------- T 시점 재구성 ---------------- */
export function investorFlowAt(tIdx, cal, flows) {
  const investors = {};
  for (const { code, label } of INVESTORS) {
    const sum = (days) => {
      const m = new Map();
      for (const dd of days) for (const [s, r] of Object.entries(flows[dd][code])) {
        const cur = m.get(s) || { name: r.name, net: 0 };
        cur.net += r.net;
        m.set(s, cur);
      }
      return m;
    };
    const recent = sum(cal.slice(tIdx - 2, tIdx + 1));
    const prior = sum(cal.slice(tIdx - 7, tIdx - 2));
    const topBuy = [], flips = [];
    for (const [s, r] of recent) {
      const p = prior.get(s)?.net ?? 0;
      topBuy.push({ symbol: s, name: r.name, net: r.net });
      if ((p < 0 && r.net > 0) || (p > 0 && r.net < 0)) flips.push({ symbol: s, name: r.name, recent_net: r.net, prior_net: p, swing: r.net - p });
    }
    const topSell = [...topBuy].sort((a, b) => a.net - b.net);
    topBuy.sort((a, b) => b.net - a.net);
    flips.sort((a, b) => Math.abs(b.swing) - Math.abs(a.swing));
    investors[code] = { label, top_net_buy: topBuy.slice(0, 300), top_net_sell: topSell.slice(0, 300), flips: flips.slice(0, 300), scanned_count: recent.size };
  }
  return { investors };
}

function dartAt(ev, T) {
  const f = (arr) => ({ items: arr.filter((it) => it.rcept_dt <= T && it.rcept_dt >= shiftDays(T, -14)) });
  return {
    capitalIncreasePaid: f(ev.capitalIncreasePaid), capitalIncreaseFree: f(ev.capitalIncreaseFree),
    convertibleBond: f(ev.convertibleBond), treasuryStock: f(ev.treasuryStock), insiderPlan: f(ev.insiderPlan),
  };
}

function earningsAt(ev, T, barsBy) {
  const items = [];
  for (const it of ev.earnings.filter((e) => e.rcept_dt <= T && e.rcept_dt >= shiftDays(T, -21))) {
    const bars = (barsBy[it.stock_code] || []).filter((b) => ymd(b.time) <= T);
    const d0 = bars.findIndex((b) => ymd(b.time) >= it.rcept_dt);
    const reaction = { 'D-1': 0, D0: null, 'D+1': null, 'D+2': null, 'D+3': null, 'D+4': null };
    if (d0 > 0) {
      const base = bars[d0 - 1].close;
      ['D0', 'D+1', 'D+2', 'D+3', 'D+4'].forEach((k, i) => { if (bars[d0 + i]) reaction[k] = Number((((bars[d0 + i].close - base) / base) * 100).toFixed(2)); });
    }
    items.push({ ...it, reaction });
  }
  return { items };
}

function quoteAt(q, bars, T) {
  const upto = bars.filter((b) => ymd(b.time) <= T);
  const last = upto[upto.length - 1];
  if (!last || ymd(last.time) !== T) return null;
  const nowClose = bars[bars.length - 1].close;
  const yr = upto.slice(-250);
  return {
    ...q, price: last.close, open: last.open, high: last.high, low: last.low, volume: last.volume,
    tradingValue: last.close * last.volume,
    marketCap: q.marketCap && nowClose ? (q.marketCap * last.close) / nowClose : null,
    week52High: Math.max(...yr.map((b) => b.high)),
    week52Low: Math.min(...yr.map((b) => b.low)),
  };
}

/* ---------------- 데이터셋 적재 ---------------- */
export async function loadDataset({ firstDate, lastDate, krxDelayMs = 250, log = console.log } = {}) {
  await mkdir(CACHE, { recursive: true });
  const benchBars = {};
  for (const s of Object.keys(BENCH)) benchBars[s] = await barsFor(s);
  const cal = benchBars['069500'].map((b) => ymd(b.time));
  const maxSel = cal.length - 1 - HORIZONS[0];
  const firstIdx = Math.max(62, cal.findIndex((d) => d >= firstDate));
  const lastIdx = lastDate ? Math.min(maxSel, cal.findLastIndex((d) => d <= lastDate)) : maxSel;
  log(`[bt] 선정일 ${cal[firstIdx]} ~ ${cal[lastIdx]} (${lastIdx - firstIdx + 1}거래일)`);

  const flows = {};
  const flowDays = cal.slice(firstIdx - 7, lastIdx + 1);
  let fetched = 0;
  for (const dd of flowDays) {
    flows[dd] = {};
    for (const { code } of INVESTORS) {
      if (!(await hasCache(`flow-${dd}-${code}`))) fetched++;
      flows[dd][code] = await dailyFlow(dd, code, { delayMs: krxDelayMs });
    }
  }
  log(`[bt] 수급 ${flowDays.length}거래일 (신규 조회 ${fetched}건)`);

  const ev = await dartEvents(shiftDays(cal[firstIdx], -21), cal[lastIdx]);
  log(`[bt] 공시: 유상 ${ev.capitalIncreasePaid.length}, 무상 ${ev.capitalIncreaseFree.length}, CB ${ev.convertibleBond.length}, 자사주 ${ev.treasuryStock.length}, 실적 ${ev.earnings.length}`);

  const barsBy = {}, quotesBy = {}, failed = [];
  for (const e of ev.earnings) {
    if (barsBy[e.stock_code]) continue;
    try { barsBy[e.stock_code] = await barsFor(e.stock_code); } catch (err) { failed.push(`${e.stock_code}: ${err.message}`); }
  }
  const watchSkeleton = WATCHLIST.map((w) => ({ symbol: w.symbol, name: w.name }));
  const enrichBy = {};
  const need = new Map(WATCHLIST.map((w) => [w.symbol, w.name]));
  for (const e of ev.earnings) need.set(e.stock_code, e.corp_name);
  for (let i = firstIdx; i <= lastIdx; i++) {
    const T = cal[i];
    const d0 = { kisQuotes: { items: watchSkeleton }, investorFlow: investorFlowAt(i, cal, flows), ...dartAt(ev, T), krEarnings: earningsAt(ev, T, barsBy) };
    enrichBy[T] = allocateEnrichment(preScreen(buildUniverse(d0), d0));
    for (const p of enrichBy[T]) need.set(p.symbol, p.name);
  }
  log(`[bt] 가격 대상 ${need.size}종목`);
  let k = 0;
  for (const [s, name] of need) {
    if (++k % 100 === 0) log(`[bt]   가격 ${k}/${need.size}`);
    try {
      barsBy[s] = await barsFor(s);
      const w = WATCHLIST.find((x) => x.symbol === s);
      quotesBy[s] = { ...(await quoteFor(s, name)), ...(w ? { market: w.market, sector: w.sector, name: w.name } : {}) };
    } catch (e) {
      failed.push(`${s} ${name}: ${e.message}`);
    }
  }
  log(`[bt] 가격 확보 ${Object.keys(quotesBy).length}, 실패 ${failed.length}`);
  return { cal, firstIdx, lastIdx, flows, ev, barsBy, quotesBy, benchBars, enrichBy, failed };
}

/** T 시점 엔진 입력 */
export function buildDay(ds, i) {
  const T = ds.cal[i];
  const symbols = new Set([...WATCHLIST.map((w) => w.symbol), ...ds.enrichBy[T].map((p) => p.symbol)]);
  const items = [], ohlcv = {};
  for (const s of symbols) {
    if (!ds.barsBy[s] || !ds.quotesBy[s]) continue;
    const q = quoteAt(ds.quotesBy[s], ds.barsBy[s], T);
    if (!q) continue;
    items.push(q);
    ohlcv[s] = ds.barsBy[s].filter((b) => ymd(b.time) <= T);
  }
  const d = {
    kisQuotes: { items }, kisOhlcv: { symbols: ohlcv },
    investorFlow: investorFlowAt(i, ds.cal, ds.flows),
    ...dartAt(ds.ev, T),
    krEarnings: earningsAt(ds.ev, T, ds.barsBy),
    shortSelling: null, marketAlerts: null, usEarnings: null, etfRebalance: null,
  };
  const today = new Date(Number(T.slice(0, 4)), Number(T.slice(4, 6)) - 1, Number(T.slice(6, 8)), 18);
  return { T, d, today, pool: Object.keys(ohlcv) };
}

/* ---------------- 성과 ---------------- */
const byDateCache = new WeakMap();
export function fwdReturn(bars, cal, tIdx, h) {
  if (!bars || tIdx + h >= cal.length) return null;
  let m = byDateCache.get(bars);
  if (!m) { m = new Map(bars.map((b) => [ymd(b.time), b])); byDateCache.set(bars, m); }
  const entry = m.get(cal[tIdx + 1]), exit = m.get(cal[tIdx + h]);
  if (!entry || !exit || !entry.open) return null;
  return ((exit.close - entry.open) / entry.open) * 100;
}

export function benchReturns(ds, i) {
  return Object.fromEntries(Object.keys(BENCH).map((s) => [s, Object.fromEntries(HORIZONS.map((h) => [h, fwdReturn(ds.benchBars[s], ds.cal, i, h)]))]));
}

export function poolReturns(ds, i, pool) {
  return Object.fromEntries(HORIZONS.map((h) => {
    const v = pool.map((s) => fwdReturn(ds.barsBy[s], ds.cal, i, h)).filter((x) => x != null);
    return [h, v.length ? v.reduce((a, b) => a + b, 0) / v.length : null];
  }));
}

/* ---------------- 통계 ---------------- */
export function basicStats(v) {
  v = v.filter((x) => x != null && Number.isFinite(x));
  if (!v.length) return { n: 0 };
  const s = [...v].sort((a, b) => a - b);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, v.length - 1));
  return { n: v.length, mean, median: s[Math.floor(s.length / 2)], sd, min: s[0], max: s[s.length - 1], winRate: (v.filter((x) => x > 0).length / v.length) * 100 };
}

/** 날짜 단위 block bootstrap — 같은 날 종목들·겹치는 보유기간의 상관을 일부 반영 */
export function bootstrapByDay(dayValues, iters = 2000, seed = 7) {
  const days = dayValues.filter((d) => d.length);
  if (days.length < 3) return null;
  let x = seed;
  const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  const means = [];
  for (let k = 0; k < iters; k++) {
    let s = 0, n = 0;
    for (let j = 0; j < days.length; j++) { const d = days[Math.floor(rnd() * days.length)]; for (const v of d) { s += v; n++; } }
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  return { lo: means[Math.floor(iters * 0.025)], hi: means[Math.floor(iters * 0.975)], pPositive: means.filter((m) => m > 0).length / iters };
}

/** 순위 상관 (Spearman) */
export function rankIC(xs, ys) {
  const pairs = xs.map((x, i) => [x, ys[i]]).filter(([a, b]) => a != null && b != null && Number.isFinite(a) && Number.isFinite(b));
  if (pairs.length < 8) return null;
  const rank = (arr) => {
    const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(arr.length);
    for (let i = 0; i < idx.length;) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(pairs.map((p) => p[0])), ry = rank(pairs.map((p) => p[1]));
  const n = pairs.length, mx = (n - 1) / 2;
  let num2 = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num2 += (rx[i] - mx) * (ry[i] - mx); dx += (rx[i] - mx) ** 2; dy += (ry[i] - mx) ** 2; }
  return dx && dy ? num2 / Math.sqrt(dx * dy) : null;
}
