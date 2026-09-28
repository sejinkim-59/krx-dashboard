import { fetchNetBuyTopByInvestorType, findRecentPublicTradingDates } from './lib/krx-public.mjs';
import { writeJson, sleep } from './lib/util.mjs';

const INVESTOR_TYPES = [
  { code: '9000', label: '외국인' },
  { code: '7050', label: '기관합계' },
  { code: '6000', label: '연기금 등' },
  { code: '8000', label: '개인' },
];
const MARKETS = ['STK', 'KSQ'];

function num(v) {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isNaN(n) ? 0 : n;
}

async function fetchNetBuyAllMarkets(code, strtDd, endDd) {
  const merged = new Map();
  for (const mktId of MARKETS) {
    const rows = await fetchNetBuyTopByInvestorType({ mktId, invstTpCd: code, strtDd, endDd });
    for (const r of rows) {
      merged.set(r.ISU_SRT_CD, { name: r.ISU_NM, net: num(r.NETBID_TRDVAL) });
    }
    await sleep(200);
  }
  return merged;
}

async function main() {
  console.log('[investor-flow] 최근 거래일 탐색 중...');
  const dates = await findRecentPublicTradingDates(8);
  if (dates.length < 8) throw new Error(`거래일을 충분히 찾지 못했습니다 (${dates.length}/8)`);
  const recentWindow = { strtDd: dates[2], endDd: dates[0] }; // 최근 3거래일
  const priorWindow = { strtDd: dates[7], endDd: dates[3] }; // 직전 5거래일
  console.log(`[investor-flow] 최근 3거래일: ${recentWindow.strtDd}~${recentWindow.endDd}, 직전 5거래일: ${priorWindow.strtDd}~${priorWindow.endDd}`);

  const byInvestor = {};
  for (const { code, label } of INVESTOR_TYPES) {
    console.log(`[investor-flow] ${label} 처리 중...`);
    const recent = await fetchNetBuyAllMarkets(code, recentWindow.strtDd, recentWindow.endDd);
    const prior = await fetchNetBuyAllMarkets(code, priorWindow.strtDd, priorWindow.endDd);

    const flips = [];
    const topBuy = [];
    const topSell = [];
    for (const [code6, r] of recent.entries()) {
      const priorNet = prior.get(code6)?.net ?? 0;
      topBuy.push({ symbol: code6, name: r.name, net: r.net });
      topSell.push({ symbol: code6, name: r.name, net: r.net });
      // 직전엔 순매도였다가 최근 순매수로, 또는 그 반대로 바뀐 종목 (전환 규모 = 변화폭)
      if ((priorNet < 0 && r.net > 0) || (priorNet > 0 && r.net < 0)) {
        flips.push({ symbol: code6, name: r.name, recent_net: r.net, prior_net: priorNet, swing: r.net - priorNet });
      }
    }
    topBuy.sort((a, b) => b.net - a.net);
    topSell.sort((a, b) => a.net - b.net);
    flips.sort((a, b) => Math.abs(b.swing) - Math.abs(a.swing));

    byInvestor[code] = {
      label,
      top_net_buy: topBuy.slice(0, 15),
      top_net_sell: topSell.slice(0, 15),
      flips: flips.slice(0, 15),
    };
  }

  await writeJson('investor-flow.json', {
    updated_at: new Date().toISOString(),
    note: '금액은 원화 기준 순매수대금 (매수-매도). "전환"은 직전 5거래일 순매도(매수)였다가 최근 3거래일 순매수(매도)로 바뀐 종목을 변화폭 순으로 정렬한 것입니다.',
    recent_window: recentWindow,
    prior_window: priorWindow,
    investors: byInvestor,
  });

  console.log('[investor-flow] 완료');
}

main().catch((e) => {
  console.error('[investor-flow] 실패:', e);
  process.exit(1);
});
