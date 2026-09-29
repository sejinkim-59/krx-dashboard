import { writeJson, sleep } from './lib/util.mjs';
import { fetchQuote, fetchDailyOhlcv, normalizeQuote, normalizeOhlcv } from './lib/kis.mjs';
import { WATCHLIST } from './lib/kis-watchlist.mjs';

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
