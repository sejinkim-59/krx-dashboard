import { writeJson, sleep } from './lib/util.mjs';
import { fetchQuote, fetchDailyOhlcv } from './lib/kis.mjs';
import { WATCHLIST } from './lib/kis-watchlist.mjs';

// KIS 응답(전부 문자열)을 공통 Quote 모델로 정규화한다. 없는 값은 null로 두고 지어내지 않는다.
function normalizeQuote(inst, o) {
  const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
  return {
    symbol: inst.symbol,
    name: inst.name,
    market: inst.market,
    sector: inst.sector || null,
    currency: 'KRW',
    price: num(o.stck_prpr),
    change: num(o.prdy_vrss),
    changePercent: num(o.prdy_ctrt),
    open: num(o.stck_oprc),
    high: num(o.stck_hgpr),
    low: num(o.stck_lwpr),
    previousClose: num(o.stck_sdpr),
    volume: num(o.acml_vol),
    tradingValue: num(o.acml_tr_pbmn),
    marketCap: num(o.hts_avls), // 억원 단위 (KIS 응답 그대로)
    week52High: num(o.w52_hgpr),
    week52Low: num(o.w52_lwpr),
    per: num(o.per),
    pbr: num(o.pbr),
    sharesOutstanding: num(o.lstn_stcn), // 상장주식수 — 희석비율(신주/기존주식수) 계산용
    isRealtime: false,
    source: 'KIS REST',
  };
}

function normalizeOhlcv(rows) {
  // KIS output2는 최신이 먼저 온다 — 차트는 과거->최신 순이 필요하므로 뒤집는다.
  return [...rows].reverse().map((r) => ({
    time: `${r.stck_bsop_date.slice(0, 4)}-${r.stck_bsop_date.slice(4, 6)}-${r.stck_bsop_date.slice(6, 8)}`,
    open: Number(r.stck_oprc),
    high: Number(r.stck_hgpr),
    low: Number(r.stck_lwpr),
    close: Number(r.stck_clpr),
    volume: Number(r.acml_vol),
  }));
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

async function main() {
  const quotes = [];
  const ohlcvBySymbol = {};
  const errors = [];

  const to = new Date();
  const from = new Date(to.getTime() - 380 * 24 * 60 * 60 * 1000); // 약 1년치 영업일 확보

  for (const inst of WATCHLIST) {
    try {
      const o = await fetchQuote(inst.symbol);
      quotes.push(normalizeQuote(inst, o));
    } catch (e) {
      errors.push(`quote:${inst.symbol}: ${e.message}`);
      console.warn(`[kis] 현재가 실패 ${inst.symbol}: ${e.message}`);
    }
    await sleep(450); // 초당 거래건수 제한 보호용 client-side throttle

    try {
      const rows = await fetchDailyOhlcv(inst.symbol, { from: fmtDate(from), to: fmtDate(to), periodDiv: 'D' });
      ohlcvBySymbol[inst.symbol] = normalizeOhlcv(rows);
    } catch (e) {
      errors.push(`ohlcv:${inst.symbol}: ${e.message}`);
      console.warn(`[kis] 기간별시세 실패 ${inst.symbol}: ${e.message}`);
    }
    await sleep(450);
  }

  await writeJson('kis-quotes.json', {
    updated_at: new Date().toISOString(),
    source: 'KIS REST (inquire-price)',
    note: '30분 주기 배치 조회 — 실시간 체결(WebSocket)이 아닙니다.',
    items: quotes,
    errors,
  });
  await writeJson('kis-ohlcv.json', {
    updated_at: new Date().toISOString(),
    source: 'KIS REST (inquire-daily-itemchartprice)',
    symbols: ohlcvBySymbol,
  });

  console.log(`[kis] 완료: 현재가 ${quotes.length}/${WATCHLIST.length}, OHLCV ${Object.keys(ohlcvBySymbol).length}/${WATCHLIST.length}, 오류 ${errors.length}건`);
}

main().catch((e) => {
  console.error('[kis] 실패:', e.message);
  process.exit(1);
});
