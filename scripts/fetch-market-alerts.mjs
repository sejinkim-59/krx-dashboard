import { fetchInvestAlertHtml, parseInvestAlertRows } from './lib/krx-public.mjs';
import { writeJson, todayKst, daysAgoKst, sleep } from './lib/util.mjs';

const KINDS = [
  { forward: 'invstcautnisu_sub', menuIndex: 1, label: '투자주의' },
  { forward: 'invstwarnisu_sub', menuIndex: 2, label: '투자경고' },
  { forward: 'invstriskisu_sub', menuIndex: 3, label: '투자위험' },
];

function toIso(d) {
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

async function main() {
  const endDate = toIso(todayKst());
  const startDate = toIso(daysAgoKst(14));
  console.log(`[market-alerts] 조회 기간: ${startDate} ~ ${endDate}`);

  const result = {};
  for (const { forward, menuIndex, label } of KINDS) {
    try {
      const html = await fetchInvestAlertHtml(forward, menuIndex, startDate, endDate);
      const rows = parseInvestAlertRows(html);
      result[forward] = { label, count: rows.length, items: rows };
      console.log(`[market-alerts] ${label}: ${rows.length}건`);
    } catch (e) {
      console.warn(`[market-alerts] ${label} 실패:`, e.message);
      result[forward] = { label, count: 0, items: [], error: String(e.message || e) };
    }
    await sleep(300);
  }

  await writeJson('market-alerts.json', {
    updated_at: new Date().toISOString(),
    range: { from: startDate, to: endDate },
    note: 'KRX KIND(기업공시채널)의 투자주의/경고/위험종목 지정 내역 (최근 2주).',
    categories: result,
  });

  console.log('[market-alerts] 완료');
}

main().catch((e) => {
  console.error('[market-alerts] 실패:', e);
  process.exit(1);
});
