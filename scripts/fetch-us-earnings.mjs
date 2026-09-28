import { fetchRecentEarnings, parseMarketCap } from './lib/nasdaq.mjs';
import { fetchDailyHistory, computeReactionSeries } from './lib/yahoo.mjs';
import { writeJson, sleep } from './lib/util.mjs';

const MIN_MARKET_CAP = 2_000_000_000; // 2B 이상만 (스몰캡 노이즈 제거)
const TOP_N = 30;

const TIME_LABEL = {
  'time-pre-market': '장전',
  'time-after-hours': '장후',
  'time-not-supplied': '미상',
};

async function main() {
  console.log('[us-earnings] 최근 실적 발표 목록 수집 중...');
  const rows = await fetchRecentEarnings(6);
  console.log(`[us-earnings] 총 ${rows.length}건 수신`);

  const seen = new Set();
  const candidates = [];
  for (const r of rows) {
    const marketCap = parseMarketCap(r.marketCap);
    if (!marketCap || marketCap < MIN_MARKET_CAP) continue;
    if (seen.has(r.symbol)) continue;
    seen.add(r.symbol);
    candidates.push({
      symbol: r.symbol,
      name: r.name,
      report_date: r.report_date,
      report_time: TIME_LABEL[r.time] || r.time,
      market_cap: marketCap,
      eps: r.eps,
      eps_forecast: r.epsForecast,
      surprise_pct: r.surprise && r.surprise !== 'N/A' ? Number(r.surprise) : null,
    });
  }
  candidates.sort((a, b) => b.market_cap - a.market_cap);
  const top = candidates.slice(0, TOP_N);
  console.log(`[us-earnings] 시총 20억달러 이상 ${candidates.length}개 중 상위 ${top.length}개 분석`);

  const items = [];
  for (const c of top) {
    try {
      const hist = await fetchDailyHistory(c.symbol, '3mo');
      const reaction = computeReactionSeries(hist, c.report_date, 3);
      items.push({ ...c, reaction });
    } catch (e) {
      console.warn(`[us-earnings] ${c.symbol} 실패:`, e.message);
      items.push({ ...c, reaction: null });
    }
    await sleep(200);
  }

  await writeJson('us-earnings-reaction.json', {
    updated_at: new Date().toISOString(),
    note: '시가총액 20억달러 이상 기업 중 최근 실적 발표 상위 종목. 장전(pre-market) 발표는 D0이, 장후(after-hours) 발표는 D+1이 시장 반응의 핵심 구간입니다. 반응(%)은 D-1 종가 대비 누적 수익률입니다.',
    min_market_cap: MIN_MARKET_CAP,
    count: items.length,
    items,
  });

  console.log('[us-earnings] 완료');
}

main().catch((e) => {
  console.error('[us-earnings] 실패:', e);
  process.exit(1);
});
