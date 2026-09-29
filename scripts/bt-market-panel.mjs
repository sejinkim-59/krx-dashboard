// 전종목(선택 편향 없음) 가격 패널. 유니버스 = 그날 상장된 보통주 중 20일 평균 거래대금 50억 이상.
// Feature 계산은 운영(v0.5)과 같은 lib/market-features.mjs를 사용한다.
// 사용: [BT_PANEL_OUT=파일명] [BT_FROM=YYYYMMDD] [BT_TO=YYYYMMDD] node scripts/bt-market-panel.mjs

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CACHE, HORIZONS } from './lib/backtest-core.mjs';
import { buildAdjustedBars, featureRowsAt } from './lib/market-features.mjs';

const files = (await readdir(CACHE)).filter((f) => /^mkt-\d{8}\.json$/.test(f)).sort();
const days = [];
for (const f of files) days.push({ date: f.slice(4, 12), data: JSON.parse(await readFile(path.join(CACHE, f), 'utf-8')) });
const ctx = buildAdjustedBars(days);
console.log(`[mkt-panel] ${ctx.cal[0]}~${ctx.cal[ctx.cal.length - 1]} ${ctx.cal.length}일, 종목 ${ctx.barsBy.size}, 분할/무상 조정 ${ctx.adjEvents}건`);

function fwd(bars, t, h) {
  const e = bars[t + 1], x = bars[t + h];
  if (!e || !x || !e.open) return null;
  return ((x.close - e.open) / e.open) * 100;
}

const from = process.env.BT_FROM || '00000000', to = process.env.BT_TO || '99999999';
const rows = [];
for (let t = 70; t < ctx.cal.length - HORIZONS[0]; t++) {
  if (ctx.cal[t] < from || ctx.cal[t] > to) continue;
  const dayRows = featureRowsAt(t, ctx);
  for (const r of dayRows) {
    delete r.noveltyEvents; delete r.pricedInLines;
    r.fwd = Object.fromEntries(HORIZONS.map((h) => [h, fwd(ctx.barsBy.get(r.symbol), t, h)]));
  }
  rows.push(...dayRows);
  if (t % 40 === 0) console.log(`[mkt-panel] ${ctx.cal[t]} 유동성 통과 ${dayRows.length}종목`);
}
await writeFile(path.join(CACHE, process.env.BT_PANEL_OUT || 'market-panel.json'), JSON.stringify({ rows }));
console.log(`[mkt-panel] 저장 ${rows.length}행`);
