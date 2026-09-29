import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJson } from './lib/util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SCRIPTS = [
  'fetch-dart-corporate-actions.mjs',
  'fetch-krx-futures.mjs',
  'fetch-investor-flow.mjs',
  'fetch-short-selling.mjs',
  'fetch-market-alerts.mjs',
  'fetch-nvda-earnings.mjs',
  'fetch-us-new-highs.mjs',
  'fetch-us-market-brief.mjs',
  'fetch-us-earnings.mjs',
  'fetch-kr-earnings.mjs',
  'fetch-etf-rebalance.mjs',
  'fetch-index-rebalance-calendar.mjs',
  'fetch-kis-market.mjs',
  // v0.5 엔진은 KRX 전종목 일별 시세가 필요하다 (v0.2에서는 실행하지 않아 기존 파이프라인 동작이 그대로 유지됨)
  ...(process.env.ENGINE_PROFILE === 'v0.5' ? ['fetch-market-daily.mjs'] : []),
  'fetch-morning-meeting.mjs',
];

const results = [];
for (const script of SCRIPTS) {
  console.log(`\n=== ${script} 실행 ===`);
  const res = spawnSync(process.execPath, [path.join(__dirname, script)], { stdio: 'inherit', env: process.env });
  results.push({ script, ok: res.status === 0 });
}

console.log('\n=== 실행 결과 요약 ===');
for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.script}`);

await writeJson('meta.json', {
  updated_at: new Date().toISOString(),
  scripts: results,
});

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error(`\n${failed.length}개 스크립트 실패`);
  process.exit(1);
}
