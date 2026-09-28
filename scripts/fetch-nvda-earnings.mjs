import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchDailyHistory, tsToDateStr } from './lib/yahoo.mjs';
import { writeJson, sleep } from './lib/util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PEERS = [
  { symbol: 'NVDA', label: 'NVIDIA' },
  { symbol: 'SOXX', label: 'SOXX(반도체 ETF)' },
  { symbol: '005930.KS', label: '삼성전자' },
  { symbol: '000660.KS', label: 'SK하이닉스' },
  { symbol: '^KS11', label: '코스피' },
];

function buildDateIndex(hist) {
  const map = new Map();
  hist.timestamps.forEach((ts, i) => {
    map.set(tsToDateStr(ts), i);
  });
  return map;
}

function findAnchorIndex(dateIndex, earningsDate) {
  const sortedDates = Array.from(dateIndex.keys()).sort();
  // 실적 발표일 이후 첫 거래일(또는 당일)의 인덱스를 D0로 사용
  for (const d of sortedDates) {
    if (d >= earningsDate) return dateIndex.get(d);
  }
  return null;
}

function reactionFor(hist, earningsDate) {
  const dateIndex = buildDateIndex(hist);
  const d0Idx = findAnchorIndex(dateIndex, earningsDate);
  if (d0Idx == null || d0Idx < 1) return null;
  const base = hist.close[d0Idx - 1];
  if (!base) return null;
  const offsets = { 'D-1': -1, D0: 0, 'D+1': 1, 'D+2': 2, 'D+3': 3, 'D+4': 4 };
  const out = {};
  for (const [label, off] of Object.entries(offsets)) {
    const idx = d0Idx + off;
    const price = hist.close[idx];
    out[label] = price != null ? +(((price - base) / base) * 100).toFixed(2) : null;
  }
  return out;
}

async function main() {
  const seedPath = path.join(__dirname, 'data-seed', 'nvda-earnings-dates.json');
  const seed = JSON.parse(await readFile(seedPath, 'utf-8'));
  const earningsDates = seed.dates.slice(-6); // 최근 6개 분기

  const perSymbol = {};
  for (const { symbol, label } of PEERS) {
    try {
      const hist = await fetchDailyHistory(symbol, '5y');
      const reactions = earningsDates.map((d) => ({ earnings_date: d, reaction: reactionFor(hist, d) })).filter((r) => r.reaction);
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
