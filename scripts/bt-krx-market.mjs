// KRX Open API로 전종목 일별 시세(시가·고가·저가·종가·거래량·거래대금·시총·상장주식수)를 날짜별로 캐시.
// 캐시된 종목(497개)이 아니라 "그날 상장된 전 종목"을 유니버스로 쓰기 위한 데이터 (선택 편향 제거).

import './lib/util.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { callApi } from './lib/krx.mjs';
import { CACHE, ymd } from './lib/backtest-core.mjs';

await mkdir(CACHE, { recursive: true });
// 인자 없으면 KODEX200 일봉 달력, 인자(from to)가 있으면 그 기간의 평일 전부(휴장일은 빈 응답 → 저장 안 함)
let cal;
if (process.argv[2]) {
  cal = [];
  const [from, to] = [process.argv[2], process.argv[3]];
  const d = new Date(Number(from.slice(0, 4)), Number(from.slice(4, 6)) - 1, Number(from.slice(6, 8)));
  const end = new Date(Number(to.slice(0, 4)), Number(to.slice(4, 6)) - 1, Number(to.slice(6, 8)));
  for (; d <= end; d.setDate(d.getDate() + 1)) {
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    cal.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`);
  }
} else {
  cal = JSON.parse(await readFile(path.join(CACHE, 'bars-069500.json'), 'utf-8')).map((b) => ymd(b.time));
}
const n = (v) => Number(String(v ?? '').replace(/,/g, '')) || 0;
let fetched = 0, skipped = 0;
for (const d of cal) {
  const file = path.join(CACHE, `mkt-${d}.json`);
  try { await readFile(file); skipped++; continue; } catch { /* fetch */ }
  const out = {};
  for (const p of ['sto/stk_bydd_trd', 'sto/ksq_bydd_trd']) {
    let rows;
    for (let a = 1; ; a++) {
      try { rows = await callApi(p, d); break; } catch (e) {
        if (a >= 5) throw e;
        console.warn(`[mkt] ${d} ${p} 재시도 ${a}: ${e.message}`);
        await new Promise((r) => setTimeout(r, 5000 * a));
      }
    }
    for (const r of rows) {
      if (!/^\d{6}$/.test(r.ISU_CD)) continue;
      out[r.ISU_CD] = [n(r.TDD_OPNPRC), n(r.TDD_HGPRC), n(r.TDD_LWPRC), n(r.TDD_CLSPRC), n(r.ACC_TRDVOL), n(r.ACC_TRDVAL), n(r.MKTCAP), n(r.LIST_SHRS), r.ISU_NM, r.MKT_NM === 'KOSPI' ? 'P' : 'Q'];
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!Object.keys(out).length) { skipped++; continue; } // 휴장일
  await writeFile(file, JSON.stringify(out));
  fetched++;
  if (fetched % 20 === 0) console.log(`[mkt] ${d} (${fetched} fetched)`);
}
console.log(`[mkt] 완료: 신규 ${fetched}, 캐시 ${skipped}, 총 ${cal.length}일`);
