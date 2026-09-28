import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJson } from './lib/util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function nextMonth(months, fromDate) {
  const y = fromDate.getUTCFullYear();
  const m = fromDate.getUTCMonth() + 1;
  const sorted = [...months].sort((a, b) => a - b);
  const upcoming = sorted.find((mo) => mo > m);
  if (upcoming) return { year: y, month: upcoming };
  return { year: y + 1, month: sorted[0] };
}

async function main() {
  const seedPath = path.join(__dirname, 'data-seed', 'index-rebalance-calendar.json');
  const seed = JSON.parse(await readFile(seedPath, 'utf-8'));
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000); // KST

  const indices = seed.indices.map((idx) => {
    const next = nextMonth(idx.months, now);
    return { ...idx, next_occurrence: `${next.year}년 ${next.month}월` };
  });

  await writeJson('index-rebalance-calendar.json', {
    updated_at: new Date().toISOString(),
    note: '정확한 시행일은 매 차수마다 거래소/지수산출기관 공지로 확정됩니다. 아래는 월 단위 정기 주기 안내입니다.',
    indices,
  });

  console.log('[index-rebalance-calendar] 완료');
}

main().catch((e) => {
  console.error('[index-rebalance-calendar] 실패:', e);
  process.exit(1);
});
