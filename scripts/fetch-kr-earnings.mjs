import { fetchAllDisclosures } from './lib/dart.mjs';
import { callApi } from './lib/krx.mjs';
import { writeJson, todayKst, daysAgoKst, sleep } from './lib/util.mjs';

const LOOKBACK_DAYS = 21;

function num(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function addDays(basDd, n) {
  const y = +basDd.slice(0, 4), m = +basDd.slice(4, 6) - 1, d = +basDd.slice(6, 8);
  const dt = new Date(Date.UTC(y, m, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10).replace(/-/g, '');
}

async function main() {
  const TODAY = todayKst();
  const BGN = daysAgoKst(LOOKBACK_DAYS);
  console.log(`[kr-earnings] 잠정실적 공시 수집: ${BGN} ~ ${TODAY}`);

  const all = await fetchAllDisclosures(BGN, TODAY);
  const seenCorp = new Map();
  for (const item of all) {
    if (!item.report_nm.includes('(잠정)실적(공정공시)') || item.report_nm.includes('정정')) continue;
    const existing = seenCorp.get(item.corp_code);
    // 연결기준을 개별기준보다 우선
    if (!existing || (item.report_nm.includes('연결') && !existing.report_nm.includes('연결'))) {
      seenCorp.set(item.corp_code, item);
    }
  }
  const disclosures = Array.from(seenCorp.values());
  console.log(`[kr-earnings] 잠정실적 공시 기업 ${disclosures.length}개`);

  if (disclosures.length === 0) {
    await writeJson('kr-earnings-reaction.json', {
      updated_at: new Date().toISOString(),
      note: `최근 ${LOOKBACK_DAYS}일간 (${BGN}~${TODAY}) 영업(잠정)실적 공정공시가 없습니다. 한국 기업들은 분기 종료 후 약 3~6주 뒤 몰아서 발표하는 경향이 있어, 실적 시즌이 아니면 비어있을 수 있습니다.`,
      count: 0,
      items: [],
    });
    console.log('[kr-earnings] 공시 없음 — 빈 결과 저장');
    return;
  }

  // 필요한 거래일 범위 전체(가장 이른 공시일 -5일 ~ 오늘)를 하루씩 KRX에서 가져와 캐시
  const minDate = disclosures.map((d) => d.rcept_dt).sort()[0];
  let cursor = addDays(minDate, -5);
  const dateCache = new Map(); // basDd -> Map(ISU_CD -> row)
  while (cursor <= TODAY) {
    try {
      const rows = await callApi('sto/stk_bydd_trd', cursor);
      if (rows.length) dateCache.set(cursor, new Map(rows.map((r) => [r.ISU_CD, r])));
    } catch (e) {
      console.warn(`[kr-earnings] KRX ${cursor} 조회 실패:`, e.message);
    }
    cursor = addDays(cursor, 1);
    await sleep(120);
  }
  const availableDates = Array.from(dateCache.keys()).sort();
  console.log(`[kr-earnings] KRX 거래일 ${availableDates.length}일 캐시 완료`);

  const items = [];
  for (const d of disclosures) {
    const d0Date = availableDates.find((x) => x >= d.rcept_dt);
    if (!d0Date) {
      items.push({ corp_name: d.corp_name, stock_code: d.stock_code, rcept_dt: d.rcept_dt, reaction: null });
      continue;
    }
    const d0Idx = availableDates.indexOf(d0Date);
    const closeAt = (idx) => {
      if (idx < 0 || idx >= availableDates.length) return null;
      const row = dateCache.get(availableDates[idx])?.get(d.stock_code);
      return row ? num(row.TDD_CLSPRC) : null;
    };
    const base = closeAt(d0Idx - 1);
    let reaction = null;
    if (base) {
      reaction = {};
      for (let off = -1; off <= 4; off++) {
        const label = off === 0 ? 'D0' : off < 0 ? `D${off}` : `D+${off}`;
        const price = closeAt(d0Idx + off);
        reaction[label] = price != null ? +(((price - base) / base) * 100).toFixed(2) : null;
      }
    }
    items.push({
      corp_name: d.corp_name,
      stock_code: d.stock_code,
      rcept_dt: d.rcept_dt,
      dart_url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${d.rcept_no}`,
      reaction,
    });
  }

  await writeJson('kr-earnings-reaction.json', {
    updated_at: new Date().toISOString(),
    note: `최근 ${LOOKBACK_DAYS}일 영업(잠정)실적 공정공시 기준. 반응(%)은 공시일 이후 첫 거래일(D0) 기준 D-1 종가 대비 누적 수익률.`,
    range: { from: BGN, to: TODAY },
    count: items.length,
    items,
  });

  console.log(`[kr-earnings] 완료: ${items.length}개`);
}

main().catch((e) => {
  console.error('[kr-earnings] 실패:', e);
  process.exit(1);
});
