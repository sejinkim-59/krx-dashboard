import { callApi } from './lib/krx.mjs';
import { fetchNetBuyTopByInvestorType, fetchShortSellingByIsin, findRecentPublicTradingDates } from './lib/krx-public.mjs';
import { writeJson, sleep } from './lib/util.mjs';

const TOP_N = 60; // 공매도 조회 대상 유니버스 (거래대금 상위, 시장 합산). 종목당 순차 요청이라 크게 늘리면 실행 시간이 길어짐

function num(v) {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isNaN(n) ? 0 : n;
}

async function buildIsinMap() {
  const map = new Map();
  for (const path of ['sto/stk_isu_base_info', 'sto/ksq_isu_base_info']) {
    // 상장일 무관 전체 목록이라 최근 영업일 아무 날짜나 사용
    const today = new Date(Date.now() + 9 * 60 * 60 * 1000);
    for (let i = 0; i < 10; i++) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      const basDd = d.toISOString().slice(0, 10).replace(/-/g, '');
      const rows = await callApi(path, basDd);
      if (rows.length) {
        for (const r of rows) map.set(r.ISU_SRT_CD, r.ISU_CD);
        break;
      }
    }
  }
  return map;
}

async function main() {
  console.log('[short-selling] 최근 공개 거래일 확인 중...');
  const [tradeDate] = await findRecentPublicTradingDates(1);
  if (!tradeDate) throw new Error('최근 거래일을 찾지 못했습니다.');
  console.log(`[short-selling] 기준일: ${tradeDate}`);

  console.log('[short-selling] 종목코드 -> 표준코드(ISIN) 매핑 구축 중...');
  const isinMap = await buildIsinMap();
  console.log(`[short-selling] ${isinMap.size}개 종목 매핑 완료`);

  console.log('[short-selling] 거래대금 상위 유니버스 선정 중...');
  const universe = [];
  for (const mktId of ['STK', 'KSQ']) {
    const rows = await fetchNetBuyTopByInvestorType({ mktId, invstTpCd: '9999', strtDd: tradeDate, endDd: tradeDate });
    for (const r of rows) universe.push({ symbol: r.ISU_SRT_CD, name: r.ISU_NM, totalTrdVal: num(r.ASK_TRDVAL), market: mktId });
    await sleep(200);
  }
  universe.sort((a, b) => b.totalTrdVal - a.totalTrdVal);
  const top = universe.slice(0, TOP_N).filter((u) => isinMap.has(u.symbol));
  console.log(`[short-selling] 유니버스 ${top.length}종목 공매도 조회 시작`);

  const items = [];
  for (const u of top) {
    try {
      const rows = await fetchShortSellingByIsin(isinMap.get(u.symbol), tradeDate, tradeDate);
      const row = rows[0];
      const shortVal = row ? num(row.CVSRTSELL_TRDVAL) : 0;
      const ratio = u.totalTrdVal ? (shortVal / u.totalTrdVal) * 100 : 0;
      items.push({
        symbol: u.symbol,
        name: u.name,
        market: u.market,
        short_sell_value: shortVal,
        total_trade_value: u.totalTrdVal,
        short_ratio_pct: +ratio.toFixed(2),
      });
    } catch (e) {
      console.warn(`[short-selling] ${u.symbol} 실패:`, e.message);
    }
    await sleep(180);
  }
  items.sort((a, b) => b.short_ratio_pct - a.short_ratio_pct);

  await writeJson('short-selling.json', {
    updated_at: new Date().toISOString(),
    trade_date: tradeDate,
    note: `거래대금 상위 ${TOP_N}종목(코스피+코스닥) 중 공매도 거래대금 비중 상위. 공매도 비중 = 당일 공매도 거래대금 / 당일 총 거래대금 x 100.`,
    universe_size: top.length,
    items: items.slice(0, 40),
  });

  console.log(`[short-selling] 완료: ${items.length}종목 처리`);
}

main().catch((e) => {
  console.error('[short-selling] 실패:', e);
  process.exit(1);
});
