import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchDailyHistory, computeReactionSeries } from './lib/yahoo.mjs';
import { writeJson, sleep } from './lib/util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PEERS = [
  { symbol: 'NVDA', label: 'NVIDIA' },
  { symbol: 'SOXX', label: 'SOXX(반도체 ETF)' },
  { symbol: '005930.KS', label: '삼성전자' },
  { symbol: '000660.KS', label: 'SK하이닉스' },
  { symbol: '^KS11', label: '코스피' },
];

async function main() {
  const seedPath = path.join(__dirname, 'data-seed', 'nvda-earnings-dates.json');
  const seed = JSON.parse(await readFile(seedPath, 'utf-8'));
  const earningsDates = seed.dates.slice(-6); // 최근 6개 분기

  const perSymbol = {};
  for (const { symbol, label } of PEERS) {
    try {
      const hist = await fetchDailyHistory(symbol, '5y');
      const reactions = earningsDates
        .map((d) => ({ earnings_date: d, reaction: computeReactionSeries(hist, d, 4) }))
        .filter((r) => r.reaction);
      perSymbol[symbol] = { label, reactions };
    } catch (e) {
      console.warn(`[nvda-earnings] ${symbol} 실패:`, e.message);
      perSymbol[symbol] = { label, reactions: [], error: String(e.message || e) };
    }
    await sleep(300);
  }

  await writeJson('nvda-earnings-reaction.json', {
    updated_at: new Date().toISOString(),
    note: '실적 발표 직전 거래일(D-1) 종가 대비 누적 수익률(%). NVDA는 장마감 후 발표하므로 D0=발표 당일, D+1이 시장 반응의 핵심 구간입니다.',
    earnings_dates_used: earningsDates,
    symbols: perSymbol,
  });

  console.log('[nvda-earnings] 완료');
}

main().catch((e) => {
  console.error('[nvda-earnings] 실패:', e);
  process.exit(1);
});
