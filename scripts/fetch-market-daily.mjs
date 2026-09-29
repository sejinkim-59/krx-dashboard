// v0.5 입력: KRX Open API 전종목 일별 시세를 최근 약 260거래일치 유지 (없는 날짜만 조회).
// CI에서는 actions/cache로 MARKET_CACHE_DIR을 보존해 매 실행마다 0~2회만 호출한다. 최초 1회는 수백 회.
// 이 파일들은 data/에 커밋하지 않는다 (용량이 크고, 파생 결과만 커밋).

import './lib/util.mjs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { callApi } from './lib/krx.mjs';

export const MARKET_CACHE_DIR = process.env.MARKET_CACHE_DIR || path.join(process.cwd(), '.cache', 'market');
const KEEP_TRADING_DAYS = 260;
const n = (v) => Number(String(v ?? '').replace(/,/g, '')) || 0;

async function fetchDay(date) {
  const out = {};
  for (const p of ['sto/stk_bydd_trd', 'sto/ksq_bydd_trd']) {
    let rows;
    for (let a = 1; ; a++) {
      try { rows = await callApi(p, date); break; } catch (e) {
        if (a >= 4) throw e;
        await new Promise((r) => setTimeout(r, 4000 * a));
      }
    }
    for (const r of rows) {
      if (!/^\d{6}$/.test(r.ISU_CD)) continue;
      out[r.ISU_CD] = [n(r.TDD_OPNPRC), n(r.TDD_HGPRC), n(r.TDD_LWPRC), n(r.TDD_CLSPRC), n(r.ACC_TRDVOL), n(r.ACC_TRDVAL), n(r.MKTCAP), n(r.LIST_SHRS), r.ISU_NM, r.MKT_NM === 'KOSPI' ? 'P' : 'Q'];
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return out;
}

async function main() {
  await mkdir(MARKET_CACHE_DIR, { recursive: true });
  const have = new Set((await readdir(MARKET_CACHE_DIR)).filter((f) => /^mkt-\d{8}\.json$/.test(f)).map((f) => f.slice(4, 12)));
  const holidays = new Set();
  try { for (const d of JSON.parse(await readFile(path.join(MARKET_CACHE_DIR, 'holidays.json'), 'utf-8'))) holidays.add(d); } catch { /* 없음 */ }

  // 오늘부터 거꾸로 평일을 훑어 KEEP_TRADING_DAYS개 거래일을 확보 (이미 있는 날·알려진 휴장일은 건너뜀)
  let trading = 0, fetched = 0, emptyToday = false;
  const cur = new Date(Date.now() + 9 * 3600 * 1000);
  for (let i = 0; i < 420 && trading < KEEP_TRADING_DAYS; i++, cur.setUTCDate(cur.getUTCDate() - 1)) {
    const dow = cur.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const date = `${cur.getUTCFullYear()}${String(cur.getUTCMonth() + 1).padStart(2, '0')}${String(cur.getUTCDate()).padStart(2, '0')}`;
    if (have.has(date)) { trading++; continue; }
    if (holidays.has(date)) continue;
    const data = await fetchDay(date);
    if (!Object.keys(data).length) {
      // 오늘/최근 며칠은 아직 미반영일 수 있으므로 휴장일로 기록하지 않는다
      if (i > 5) holidays.add(date); else emptyToday = true;
      continue;
    }
    await writeFile(path.join(MARKET_CACHE_DIR, `mkt-${date}.json`), JSON.stringify(data));
    have.add(date);
    trading++;
    fetched++;
  }
  await writeFile(path.join(MARKET_CACHE_DIR, 'holidays.json'), JSON.stringify([...holidays].sort()));
  console.log(`[market-daily] 거래일 ${trading}일 확보 (신규 조회 ${fetched}일${emptyToday ? ', 최근일 일부 미반영' : ''}) — ${MARKET_CACHE_DIR}`);
}

// 직접 실행할 때만 수집 (fetch-morning-meeting이 loadMarketDays만 import할 때는 실행하지 않음)
if (process.argv[1]?.endsWith('fetch-market-daily.mjs')) {
  main().catch((e) => { console.error('[market-daily] 실패:', e.message); process.exit(1); });
}

/** 캐시된 최근 N거래일을 날짜 오름차순으로 로드 */
export async function loadMarketDays(limit = KEEP_TRADING_DAYS) {
  const files = (await readdir(MARKET_CACHE_DIR)).filter((f) => /^mkt-\d{8}\.json$/.test(f)).sort().slice(-limit);
  const days = [];
  for (const f of files) {
    const data = JSON.parse(await readFile(path.join(MARKET_CACHE_DIR, f), 'utf-8'));
    if (Object.keys(data).length) days.push({ date: f.slice(4, 12), data }); // 미반영 상태로 저장된 빈 날짜는 무시
  }
  return days;
}
