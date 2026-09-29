import './lib/util.mjs'; // .env.local 로드 (사이드이펙트만 필요)
import { fetchQuote, fetchDailyOhlcv } from './lib/kis.mjs';

async function main() {
  console.log('[kis-test] 삼성전자(005930) 현재가 조회 중...');
  const quote = await fetchQuote('005930');
  console.log('[kis-test] 응답 필드 목록:', Object.keys(quote));
  console.log('[kis-test] 현재가:', quote.stck_prpr, '전일대비:', quote.prdy_vrss, '등락률:', quote.prdy_ctrt);

  console.log('[kis-test] SK하이닉스(000660) 현재가 조회 중...');
  const quote2 = await fetchQuote('000660');
  console.log('[kis-test] 현재가:', quote2.stck_prpr, '등락률:', quote2.prdy_ctrt);

  console.log('[kis-test] 삼성전자 기간별시세(최근 20영업일) 조회 중...');
  const to = new Date();
  const from = new Date(to.getTime() - 40 * 24 * 60 * 60 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const ohlcv = await fetchDailyOhlcv('005930', { from: fmt(from), to: fmt(to), periodDiv: 'D' });
  console.log('[kis-test] OHLCV 건수:', ohlcv.length);
  if (ohlcv.length) console.log('[kis-test] 최신 레코드 필드:', Object.keys(ohlcv[0]), ohlcv[0]);

  console.log('\nKIS REST\nConnected');
}

main().catch((e) => {
  console.error('[kis-test] 실패:', e.message);
  process.exit(1);
});
