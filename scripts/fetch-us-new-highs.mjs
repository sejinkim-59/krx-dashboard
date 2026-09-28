import { fetchSparkBatch } from './lib/yahoo.mjs';
import { LARGE_CAP_UNIVERSE } from './lib/large-cap-tickers.mjs';
import { writeJson, sleep } from './lib/util.mjs';

const SP500_CSV_URL = 'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/master/data/constituents.csv';

async function fetchSp500Tickers() {
  const res = await fetch(SP500_CSV_URL);
  if (!res.ok) throw new Error(`S&P500 목록 요청 실패: ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split('\n').slice(1);
  return lines
    .map((line) => line.split(',')[0].trim())
    .filter(Boolean)
    .map((s) => s.replace(/\./g, '-')); // Yahoo 표기(BRK.B -> BRK-B)에 맞춤
}

function computeNewHighs(dataBySymbol, windowDays) {
  const out = [];
  for (const [symbol, { closes }] of Object.entries(dataBySymbol)) {
    const clean = closes.filter((c) => typeof c === 'number' && !Number.isNaN(c));
    if (clean.length < windowDays + 1) continue;
    const window = clean.slice(-windowDays);
    const today = window[window.length - 1];
    const priorMax = Math.max(...window.slice(0, -1));
    const windowMax = Math.max(...window);
    if (today >= windowMax) {
      const prevClose = clean[clean.length - 2];
      out.push({
        symbol,
        close: today,
        day_change_pct: prevClose ? +(((today - prevClose) / prevClose) * 100).toFixed(2) : null,
        pct_above_prior_window: priorMax ? +(((today - priorMax) / priorMax) * 100).toFixed(2) : null,
      });
    }
  }
  out.sort((a, b) => (b.pct_above_prior_window ?? -Infinity) - (a.pct_above_prior_window ?? -Infinity));
  return out;
}

async function main() {
  console.log('[us-new-highs] S&P500 티커 목록 수집 중...');
  const sp500 = await fetchSp500Tickers();
  console.log(`[us-new-highs] S&P500 ${sp500.length}개 종목`);

  console.log('[us-new-highs] S&P500 가격 히스토리 배치 조회 중 (20일 신고가용)...');
  const sp500Data = await fetchSparkBatch(sp500, '3mo');
  const newHighs20d = computeNewHighs(sp500Data, 20);

  await sleep(1000);

  console.log('[us-new-highs] 대형주 유니버스 가격 히스토리 배치 조회 중 (50일 신고가용)...');
  const largeCapData = await fetchSparkBatch(LARGE_CAP_UNIVERSE, '4mo');
  const newHighs50d = computeNewHighs(largeCapData, 50);

  await writeJson('us-new-highs-20d.json', {
    updated_at: new Date().toISOString(),
    universe: 'S&P 500',
    universe_size: sp500.length,
    window_days: 20,
    count: newHighs20d.length,
    items: newHighs20d,
  });

  await writeJson('us-new-highs-50d.json', {
    updated_at: new Date().toISOString(),
    universe: 'Dow 30 + Nasdaq 100 (대형주)',
    universe_size: LARGE_CAP_UNIVERSE.length,
    window_days: 50,
    count: newHighs50d.length,
    items: newHighs50d,
  });

  console.log(`[us-new-highs] 완료: 20일 신고가 ${newHighs20d.length}개, 50일 신고가(대형주) ${newHighs50d.length}개`);
}

main().catch((e) => {
  console.error('[us-new-highs] 실패:', e);
  process.exit(1);
});
