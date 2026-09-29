// Selection Engine v0.2 Point-in-time Backtest
// "과거 매일 이 엔진이 돌았다면 무엇을 골랐고, 그 뒤 어떻게 됐나"를 재현한다.
// 원칙: 각 날짜 T에는 T 장마감 시점까지 알 수 있었던 데이터만 쓴다 (look-ahead 금지).
//  - 수급: KRX 일별 투자자별 순매수(전종목)를 받아 T 기준 "최근 3거래일 vs 직전 5거래일"을 다시 합산
//  - 공시: DART 공시를 받아 T 기준 production과 같은 lookback(14일/실적 21일)으로 필터
//  - 가격: KIS 일봉을 T까지 자름. 시총은 현재 상장주식수 × T 종가로 근사
//  - Discovery 추가조회 대상도 T 시점 pre-screen으로 다시 뽑는다 (오늘 뽑힌 종목을 과거에 쓰지 않음)
//  - 진입: T+1 시가 (신호는 T 장마감 후에야 확정되므로), 청산: T+h 종가
// 재현 불가(현재 스냅샷만 존재) → 제외: 공매도 비중, 투자경고 지정, 미국 실적, ETF 구성 변화

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writeJson, sleep } from './lib/util.mjs';
import { fetchQuote, fetchDailyOhlcv, normalizeQuote, normalizeOhlcv } from './lib/kis.mjs';
import { fetchNetBuyTopByInvestorType } from './lib/krx-public.mjs';
import { fetchAllDisclosures, fetchPiicDecsn, fetchFricDecsn, fetchCvbdIsDecsn, fetchTsstkAqDecsn, fetchTsstkDpDecsn } from './lib/dart.mjs';
import { WATCHLIST } from './lib/kis-watchlist.mjs';
import { runSelectionEngine, buildUniverse } from './lib/selection-engine.mjs';
import { preScreen, allocateEnrichment } from './lib/discovery-enrich.mjs';

const CACHE = path.join(process.cwd(), '.cache', 'backtest');
const SELECTION_DAYS = Number(process.env.BT_DAYS || 22); // 약 한 달
const HORIZONS = [5, 10, 20];
const ROUND_TRIP_COST_PCT = 0.3; // 거래세+수수료+슬리피지 보수적 가정
const BENCH = { '069500': 'KODEX 200', '229200': 'KODEX 코스닥150' };
const INVESTORS = [
  { code: '9000', label: '외국인' }, { code: '7050', label: '기관합계' },
  { code: '6000', label: '연기금 등' }, { code: '8000', label: '개인' },
];

/* ---------------- cache ---------------- */
async function cached(name, fn) {
  const file = path.join(CACHE, `${name}.json`);
  try { return JSON.parse(await readFile(file, 'utf-8')); } catch { /* miss */ }
  const v = await fn();
  await writeFile(file, JSON.stringify(v));
  return v;
}
const ymd = (s) => s.replace(/-/g, '');
const dash = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
function shiftDays(yyyymmdd, days) {
  const d = new Date(Number(yyyymmdd.slice(0, 4)), Number(yyyymmdd.slice(4, 6)) - 1, Number(yyyymmdd.slice(6, 8)) + days);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}
const num = (v) => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isNaN(n) ? 0 : n; };

/* ---------------- KIS: 약 300봉 (100봉 x 3 페이지) ---------------- */
async function barsFor(symbol) {
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
async function quoteFor(symbol, name) {
  return cached(`quote-${symbol}`, async () => {
    const o = await fetchQuote(symbol);
    await sleep(400);
    return normalizeQuote({ symbol, name }, o);
  });
}

/* ---------------- KRX 일별 수급 (전종목) ---------------- */
async function dailyFlow(date, code) {
  return cached(`flow-${date}-${code}`, async () => {
    const out = {};
    for (const mktId of ['STK', 'KSQ']) {
      // KRX는 요청이 몰리면 JSON 대신 에러 HTML을 돌려준다 → 대기 후 재시도
      let rows;
      for (let attempt = 1; ; attempt++) {
        try {
          rows = await fetchNetBuyTopByInvestorType({ mktId, invstTpCd: code, strtDd: date, endDd: date });
          break;
        } catch (e) {
          if (attempt >= 6) throw e;
          console.warn(`[bt] KRX 제한 추정 (${date} ${code} ${mktId}), ${30 * attempt}초 대기 후 재시도`);
          await sleep(30000 * attempt);
        }
      }
      for (const r of rows) out[r.ISU_SRT_CD] = { name: r.ISU_NM, net: num(r.NETBID_TRDVAL) };
      await sleep(250);
    }
    return out;
  });
}

/** production(fetch-investor-flow)과 동일한 구조·정렬·300개 컷을 T 시점으로 재구성 */
function investorFlowAt(tIdx, cal, flows) {
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

/* ---------------- DART (기간 전체 1회 수집 후 T마다 필터) ---------------- */
async function dartEvents(bgn, end) {
  return cached(`dart-${bgn}-${end}`, async () => {
    const all = await fetchAllDisclosures(bgn, end);
    const pick = (kw, ex = ['정정']) => all.filter((i) => i.report_nm.includes(kw) && !ex.some((e) => i.report_nm.includes(e)) && i.stock_code);
    const detail = async (items, fn, map) => {
      const out = [];
      for (const it of items) {
        let d = {};
        try { d = (await fn(it.corp_code, it.rcept_dt))[0] || {}; } catch { /* 상세 실패 시 기본 필드만 */ }
        out.push({ corp_name: it.corp_name, stock_code: it.stock_code, rcept_no: it.rcept_no, rcept_dt: it.rcept_dt, ...map(d) });
        await sleep(120);
      }
      return out;
    };
    const earningsSeen = new Map();
    for (const it of all) {
      if (!it.report_nm.includes('(잠정)실적(공정공시)') || it.report_nm.includes('정정') || !it.stock_code) continue;
      if (!earningsSeen.has(it.stock_code + it.rcept_dt)) earningsSeen.set(it.stock_code + it.rcept_dt, { corp_name: it.corp_name, stock_code: it.stock_code, rcept_dt: it.rcept_dt });
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

function dartAt(ev, T) {
  const win = (days) => (it) => it.rcept_dt <= T && it.rcept_dt >= shiftDays(T, -days);
  const f = (arr) => ({ items: arr.filter(win(14)) });
  return {
    capitalIncreasePaid: f(ev.capitalIncreasePaid), capitalIncreaseFree: f(ev.capitalIncreaseFree),
    convertibleBond: f(ev.convertibleBond), treasuryStock: f(ev.treasuryStock), insiderPlan: f(ev.insiderPlan),
  };
}

/** 실적 반응: T까지의 일봉만으로 D-1 종가 대비 누적 수익률 (미래 봉 사용 금지) */
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

/** T 시점 Quote: 가격·거래량은 T 봉, 시총은 현재 상장주식수 기준으로 T 종가에 맞춰 근사 */
function quoteAt(q, bars, T) {
  const upto = bars.filter((b) => ymd(b.time) <= T);
  const last = upto[upto.length - 1];
  if (!last || ymd(last.time) !== T) return null; // T에 거래 없음(정지 등)
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

/* ---------------- 성과 ---------------- */
function fwdReturn(bars, cal, tIdx, h) {
  if (!bars || tIdx + h >= cal.length) return null;
  const byDate = new Map(bars.map((b) => [ymd(b.time), b]));
  const entry = byDate.get(cal[tIdx + 1]), exit = byDate.get(cal[tIdx + h]);
  if (!entry || !exit || !entry.open) return null;
  return ((exit.close - entry.open) / entry.open) * 100;
}

function stats(rets) {
  const v = rets.filter((x) => x != null);
  if (!v.length) return { n: 0 };
  const s = [...v].sort((a, b) => a - b);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return {
    n: v.length,
    winRate: (v.filter((x) => x > 0).length / v.length) * 100,
    winRateNet: (v.filter((x) => x - ROUND_TRIP_COST_PCT > 0).length / v.length) * 100,
    mean, median: s[Math.floor(s.length / 2)], min: s[0], max: s[s.length - 1],
  };
}

/* ---------------- main ---------------- */
async function main() {
  await mkdir(CACHE, { recursive: true });

  console.log('[bt] 거래일 달력 (KODEX 200 일봉 기준)');
  const benchBars = {};
  for (const s of Object.keys(BENCH)) benchBars[s] = await barsFor(s);
  const cal = benchBars['069500'].map((b) => ymd(b.time));
  // 선정일은 최소 D+5 성과를 측정할 수 있는 날까지만 (그 이후 선정은 아직 결과가 없다)
  const lastIdx = cal.length - 1 - HORIZONS[0];
  const firstSel = Number(process.env.BT_FIRST || '') ? cal.indexOf(process.env.BT_FIRST) : cal.length - SELECTION_DAYS;
  const selDates = cal.slice(firstSel, lastIdx + 1);
  console.log(`[bt] 선정일 ${selDates[0]} ~ ${selDates[selDates.length - 1]} (${selDates.length}거래일)`);

  console.log('[bt] KRX 일별 투자자 수급 수집');
  const flowDays = cal.slice(firstSel - 7, lastIdx + 1);
  const flows = {};
  for (const dd of flowDays) {
    flows[dd] = {};
    for (const { code } of INVESTORS) flows[dd][code] = await dailyFlow(dd, code);
  }

  console.log('[bt] DART 공시 수집');
  const ev = await dartEvents(shiftDays(selDates[0], -21), selDates[selDates.length - 1]);
  console.log(`[bt] 공시: 유상 ${ev.capitalIncreasePaid.length}, 무상 ${ev.capitalIncreaseFree.length}, CB ${ev.convertibleBond.length}, 자사주 ${ev.treasuryStock.length}, 실적 ${ev.earnings.length}`);

  // --- 1차: T마다 pre-screen으로 Discovery 조회 대상 결정 ---
  // production pre-screen은 실적 반응(+)도 쓰므로, 실적 공시 종목의 일봉을 먼저 확보해 T 시점 반응을 계산한다.
  const barsBy = {}, quotesBy = {}, failed = [];
  for (const e of ev.earnings) {
    try { barsBy[e.stock_code] = await barsFor(e.stock_code); } catch (err) { failed.push(`${e.stock_code} ${e.corp_name}: ${err.message}`); }
  }
  const watchSkeleton = WATCHLIST.map((w) => ({ symbol: w.symbol, name: w.name }));
  const enrichBy = {};
  const need = new Map(WATCHLIST.map((w) => [w.symbol, w.name]));
  for (const e of ev.earnings) need.set(e.stock_code, e.corp_name);
  for (let i = firstSel; i <= lastIdx; i++) {
    const T = cal[i];
    const d0 = { kisQuotes: { items: watchSkeleton }, investorFlow: investorFlowAt(i, cal, flows), ...dartAt(ev, T), krEarnings: earningsAt(ev, T, barsBy) };
    const picks = allocateEnrichment(preScreen(buildUniverse(d0), d0));
    enrichBy[T] = picks;
    for (const p of picks) need.set(p.symbol, p.name);
  }
  console.log(`[bt] 가격 조회 대상 (관심종목 + 날짜별 Discovery 합집합): ${need.size}종목`);

  let k = 0;
  for (const [s, name] of need) {
    k++;
    if (k % 50 === 0) console.log(`[bt]   ${k}/${need.size}`);
    try {
      barsBy[s] = await barsFor(s);
      const w = WATCHLIST.find((x) => x.symbol === s);
      quotesBy[s] = { ...(await quoteFor(s, name)), ...(w ? { market: w.market, sector: w.sector, name: w.name } : {}) };
    } catch (e) {
      failed.push(`${s} ${name}: ${e.message}`);
    }
  }
  console.log(`[bt] 가격 확보 ${Object.keys(barsBy).length}, 실패 ${failed.length}`);

  // --- 2차: T마다 엔진 실행 ---
  const days = [];
  for (let i = firstSel; i <= lastIdx; i++) {
    const T = cal[i];
    const symbols = new Set([...WATCHLIST.map((w) => w.symbol), ...enrichBy[T].map((p) => p.symbol)]);
    const items = [], ohlcv = {};
    for (const s of symbols) {
      if (!barsBy[s] || !quotesBy[s]) continue;
      const q = quoteAt(quotesBy[s], barsBy[s], T);
      if (!q) continue;
      items.push(q);
      ohlcv[s] = barsBy[s].filter((b) => ymd(b.time) <= T);
    }
    const d = {
      kisQuotes: { items }, kisOhlcv: { symbols: ohlcv },
      investorFlow: investorFlowAt(i, cal, flows),
      ...dartAt(ev, T),
      krEarnings: earningsAt(ev, T, barsBy),
      shortSelling: null, marketAlerts: null, usEarnings: null, etfRebalance: null,
    };
    const today = new Date(Number(T.slice(0, 4)), Number(T.slice(4, 6)) - 1, Number(T.slice(6, 8)), 18);
    const r = runSelectionEngine(d, T, 'Neutral', today);

    const pool = Object.keys(ohlcv);
    const poolRet = (h) => { const v = pool.map((s) => fwdReturn(barsBy[s], cal, i, h)).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    const bench = Object.fromEntries(Object.keys(BENCH).map((s) => [s, Object.fromEntries(HORIZONS.map((h) => [h, fwdReturn(benchBars[s], cal, i, h)]))]));
    days.push({
      date: T,
      priceUniverse: pool.length,
      slots: r.dailyOutput.map((s) => ({ bucket: s.bucket, filled: s.picks.length, requested: s.requested })),
      pool: Object.fromEntries(HORIZONS.map((h) => [h, poolRet(h)])),
      bench,
      picks: r.finalPicks.map((p) => ({
        symbol: p.symbol, name: p.company, bucket: p.bucket, strategy: p.strategy, score: p.score,
        capRank: p.marketCapRank, pricedIn: p.pricedIn.verdict,
        ret: Object.fromEntries(HORIZONS.map((h) => [h, fwdReturn(barsBy[p.symbol], cal, i, h)])),
      })),
    });
    console.log(`[bt] ${T}: ${r.finalPicks.map((p) => `${p.company}(${p.bucket[0]})`).join(', ') || '선정 없음'}`);
  }

  // --- 집계 ---
  const allPicks = days.flatMap((dd) => dd.picks.map((p) => ({ ...p, date: dd.date, bench: dd.bench, pool: dd.pool })));
  const summary = {};
  for (const h of HORIZONS) {
    const withRet = allPicks.filter((p) => p.ret[h] != null);
    const ex = (p, ref) => (ref == null ? null : p.ret[h] - ref);
    const byBucket = {};
    for (const b of ['MARKET_LEADER', 'DISCOVERY', 'EVENT_DRIVEN', 'INFLECTION']) {
      const g = withRet.filter((p) => p.bucket === b);
      byBucket[b] = { ...stats(g.map((p) => p.ret[h])), beatKospi200: g.length ? (g.filter((p) => ex(p, p.bench['069500'][h]) > 0).length / g.length) * 100 : null };
    }
    const daily = days.filter((dd) => dd.picks.some((p) => p.ret[h] != null)).map((dd) => {
      const v = dd.picks.map((p) => p.ret[h]).filter((x) => x != null);
      return { date: dd.date, portfolio: v.reduce((a, b) => a + b, 0) / v.length, kospi200: dd.bench['069500'][h], kosdaq150: dd.bench['229200'][h], pool: dd.pool[h] };
    });
    summary[`D+${h}`] = {
      picks: stats(withRet.map((p) => p.ret[h])),
      beatKospi200Rate: withRet.length ? (withRet.filter((p) => ex(p, p.bench['069500'][h]) > 0).length / withRet.length) * 100 : null,
      beatPoolRate: withRet.length ? (withRet.filter((p) => ex(p, p.pool[h]) > 0).length / withRet.length) * 100 : null,
      meanExcessVsKospi200: stats(withRet.map((p) => ex(p, p.bench['069500'][h]))).mean ?? null,
      meanExcessVsPool: stats(withRet.map((p) => ex(p, p.pool[h]))).mean ?? null,
      byBucket,
      dailyPortfolio: {
        days: daily.length,
        positiveDays: daily.filter((x) => x.portfolio > 0).length,
        beatKospi200Days: daily.filter((x) => x.kospi200 != null && x.portfolio > x.kospi200).length,
        meanPortfolio: stats(daily.map((x) => x.portfolio)).mean ?? null,
        meanKospi200: stats(daily.map((x) => x.kospi200)).mean ?? null,
        meanKosdaq150: stats(daily.map((x) => x.kosdaq150)).mean ?? null,
        meanPool: stats(daily.map((x) => x.pool)).mean ?? null,
      },
    };
  }

  await writeJson('backtest-v0.2.json', {
    generated_at: new Date().toISOString(),
    engineVersion: 'v0.2',
    period: { from: selDates[0], to: selDates[selDates.length - 1], selectionDays: selDates.length },
    method: {
      entry: 'T+1 시가', exit: 'T+h 종가', costRoundTripPct: ROUND_TRIP_COST_PCT,
      pointInTime: ['KRX 일별 수급 재합산', 'DART 공시 T 기준 lookback 필터', 'KIS 일봉 T까지 절단', 'Discovery 대상 T 시점 pre-screen'],
      approximations: ['시총 = 현재 상장주식수 x T 종가', '52주 고점 = 확보된 최대 250봉', '거래대금 = 종가 x 거래량'],
      excluded: ['공매도 비중', '투자경고 지정', '미국 실적(Global Peer)', 'ETF 구성 변화', '시장 국면(Neutral 고정, 선정에는 영향 없음)'],
      priceFetchFailures: failed,
    },
    summary,
    days,
  });

  const f = (x, d = 1) => (x == null ? '-' : `${x > 0 ? '+' : ''}${x.toFixed(d)}`);
  console.log('\n===== 결과 =====');
  for (const [h, s] of Object.entries(summary)) {
    console.log(`\n[${h}] 종목 ${s.picks.n}건 | 승률 ${s.picks.winRate?.toFixed(1)}% (비용 차감 ${s.picks.winRateNet?.toFixed(1)}%) | 평균 ${f(s.picks.mean)}% 중앙값 ${f(s.picks.median)}% | KOSPI200 초과 비율 ${s.beatKospi200Rate?.toFixed(1)}% 평균초과 ${f(s.meanExcessVsKospi200)}%p | 후보풀 대비 초과 비율 ${s.beatPoolRate?.toFixed(1)}% 평균초과 ${f(s.meanExcessVsPool)}%p`);
    const dp = s.dailyPortfolio;
    console.log(`  일별 5종목 포트폴리오: ${dp.days}일 중 수익 ${dp.positiveDays}일, KOSPI200 초과 ${dp.beatKospi200Days}일 | 평균 ${f(dp.meanPortfolio)}% vs KOSPI200 ${f(dp.meanKospi200)}% / KOSDAQ150 ${f(dp.meanKosdaq150)}% / 후보풀 ${f(dp.meanPool)}%`);
    for (const [b, x] of Object.entries(s.byBucket)) if (x.n) console.log(`  - ${b}: ${x.n}건 승률 ${x.winRate.toFixed(1)}% 평균 ${f(x.mean)}% KOSPI200초과 ${x.beatKospi200?.toFixed(0)}%`);
  }
}

main().catch((e) => {
  console.error('[bt] 실패:', e);
  process.exit(1);
});
