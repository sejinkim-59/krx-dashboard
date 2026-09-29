// 연구용: 네이버 모바일 API에서 종목별 일별 외국인·기관·개인 순매수 수량을 장기간 수집 (종목당 캐시).
// production의 KRX 전종목 수급과 원천은 같은 거래소 데이터지만, 연기금 구분이 없고 기관은 합계만 있다.
// 사용: node scripts/bt-naver-flow.mjs [sinceDate=20250901]

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CACHE } from './lib/backtest-core.mjs';

const since = process.argv[2] || '20250901';
const symbols = JSON.parse(await readFile(path.join(CACHE, 'liquid-symbols.json'), 'utf-8'));
const n = (v) => Number(String(v ?? '').replace(/[,+]/g, '')) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function page(symbol, bizdate) {
  for (let a = 1; a <= 6; a++) {
    try {
      const r = await fetch(`https://m.stock.naver.com/api/stock/${symbol}/trend?pageSize=60&bizdate=${bizdate}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (r.status === 404) return [];
      const t = await r.text();
      if (!t) return [];
      return JSON.parse(t);
    } catch (e) {
      if (a === 6) throw e;
      await sleep(3000 * a);
    }
  }
}

let done = 0, cached = 0, failed = 0;
for (const s of symbols) {
  const file = path.join(CACHE, `nflow-${s}.json`);
  try { await readFile(file); cached++; continue; } catch { /* fetch */ }
  try {
    const out = [];
    let biz = '20260930';
    for (let p = 0; p < 8; p++) {
      const rows = await page(s, biz);
      await sleep(200);
      if (!rows.length) break;
      for (const r of rows) out.push([r.bizdate, n(r.foreignerPureBuyQuant), n(r.organPureBuyQuant), n(r.individualPureBuyQuant), n(r.closePrice)]);
      biz = rows[rows.length - 1].bizdate;
      if (biz < since) break;
    }
    out.sort((a, b) => a[0].localeCompare(b[0]));
    await writeFile(file, JSON.stringify(out));
    done++;
  } catch (e) {
    failed++;
    console.warn(`[nflow] ${s} 실패: ${e.message}`);
  }
  if ((done + failed) % 100 === 0 && done + failed > 0) console.log(`[nflow] ${done + failed + cached}/${symbols.length} (신규 ${done}, 실패 ${failed})`);
}
console.log(`[nflow] 완료: 신규 ${done}, 캐시 ${cached}, 실패 ${failed}`);
