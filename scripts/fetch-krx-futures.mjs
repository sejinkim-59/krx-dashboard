import { findRecentAvailableDates, callApi } from './lib/krx.mjs';
import { writeJson } from './lib/util.mjs';

const KOSPI_PATH = 'drv/eqsfu_stk_bydd_trd';
const KOSDAQ_PATH = 'drv/eqkfu_ksq_bydd_trd';

function num(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

async function main() {
  console.log('[krx-futures] 최근 데이터 반영일 탐색 중...');
  const kospiDates = await findRecentAvailableDates(KOSPI_PATH, 2);
  const [latest, prev] = kospiDates;
  console.log(`[krx-futures] 최신 반영일: ${latest.basDd}, 직전: ${prev?.basDd ?? '없음'}`);

  const kosdaqLatestRows = await callApi(KOSDAQ_PATH, latest.basDd);
  const kosdaqPrevRows = prev ? await callApi(KOSDAQ_PATH, prev.basDd) : [];

  const latestRows = [...latest.rows, ...kosdaqLatestRows];
  const prevRows = [...(prev?.rows || []), ...kosdaqPrevRows];
  const prevByCode = new Map(prevRows.map((r) => [r.ISU_CD, r]));

  // ---- 미결제약정(OI) 랭킹 ----
  const oiRanking = latestRows
    .map((r) => {
      const oi = num(r.ACC_OPNINT_QTY);
      if (!oi) return null;
      const prevOi = num(prevByCode.get(r.ISU_CD)?.ACC_OPNINT_QTY);
      return {
        symbol: r.ISU_CD,
        name: r.ISU_NM?.trim(),
        product: r.PROD_NM,
        oi,
        oi_change: prevOi != null ? oi - prevOi : null,
        close: num(r.TDD_CLSPRC),
        volume: num(r.ACC_TRDVOL),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.oi - a.oi)
    .slice(0, 50);

  // ---- 베이시스(콘탱고/백워데이션) ----
  const basisAll = latestRows
    .map((r) => {
      const close = num(r.TDD_CLSPRC);
      const spot = num(r.SPOT_PRC);
      const volume = num(r.ACC_TRDVOL);
      if (!close || !spot || !volume) return null; // 실제 체결이 있는 종목만
      const basis = close - spot;
      const basisPct = (basis / spot) * 100;
      return {
        symbol: r.ISU_CD,
        name: r.ISU_NM?.trim(),
        product: r.PROD_NM,
        futures_price: close,
        spot_price: spot,
        basis: +basis.toFixed(2),
        basis_pct: +basisPct.toFixed(3),
        volume,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.basis_pct - a.basis_pct);

  const contangoTop = basisAll.slice(0, 20);
  const backwardationTop = basisAll.slice(-20).reverse();

  await writeJson('krx-futures-oi.json', {
    updated_at: new Date().toISOString(),
    data_date: latest.basDd,
    prev_data_date: prev?.basDd ?? null,
    note: 'KRX Open API 데이터 반영 지연으로 최근 영업일 기준이 아닌, 실제 데이터가 존재하는 가장 최근 반영일 기준입니다.',
    count: oiRanking.length,
    items: oiRanking,
  });

  await writeJson('krx-futures-basis.json', {
    updated_at: new Date().toISOString(),
    data_date: latest.basDd,
    note: '베이시스 = 선물종가 - 현물가. 콘탱고(+) 상위 20 / 백워데이션(-) 상위 20.',
    contango: contangoTop,
    backwardation: backwardationTop,
  });

  console.log(`[krx-futures] 완료: OI ${oiRanking.length}종목, 베이시스 대상 ${basisAll.length}종목`);
}

main().catch((e) => {
  console.error('[krx-futures] 실패:', e);
  process.exit(1);
});
