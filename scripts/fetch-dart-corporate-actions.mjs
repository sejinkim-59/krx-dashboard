import { fetchAllDisclosures, fetchPiicDecsn, fetchFricDecsn, fetchCvbdIsDecsn, fetchTsstkAqDecsn, fetchTsstkDpDecsn } from './lib/dart.mjs';
import { writeJson, todayKst, daysAgoKst } from './lib/util.mjs';

const TODAY = todayKst();
const BGN = daysAgoKst(14); // 최근 2주치를 유지하며 캘린더 형태로 누적 표시

const CATS = {
  capitalIncreasePaid: { keyword: '유상증자결정', exclude: ['정정'] },
  capitalIncreaseFree: { keyword: '무상증자결정', exclude: ['정정'] },
  convertibleBond: { keyword: '전환사채권발행결정', exclude: ['정정'] },
  treasuryStockAcquire: { keyword: '자기주식취득결정', exclude: ['정정'] },
  treasuryStockDispose: { keyword: '자기주식처분결정', exclude: ['정정'] },
  insiderPlan: { keyword: '특정증권등거래계획보고서', exclude: [] },
};

function matches(reportNm, spec) {
  const keywords = Array.isArray(spec.keyword) ? spec.keyword : [spec.keyword];
  const hit = keywords.some((k) => reportNm.includes(k));
  if (!hit) return false;
  if (spec.exclude?.some((ex) => reportNm.includes(ex))) return false;
  return true;
}

const dartUrl = (rceptNo) => `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rceptNo}`;

async function main() {
  console.log(`[dart] 공시 목록 수집: ${BGN} ~ ${TODAY}`);
  const all = await fetchAllDisclosures(BGN, TODAY);
  console.log(`[dart] 총 ${all.length}건 수신`);

  const buckets = Object.fromEntries(Object.keys(CATS).map((k) => [k, []]));
  for (const item of all) {
    for (const [cat, spec] of Object.entries(CATS)) {
      if (matches(item.report_nm, spec)) buckets[cat].push(item);
    }
  }

  // ---- 유상증자결정: DART API에는 배정기준일 필드가 없어(주주배정이 아닌 경우 미제공),
  // 증자방식·조달목적·신주수 중심으로 제공하고 원문 링크를 함께 준다 ----
  const capitalIncreasePaid = [];
  for (const item of buckets.capitalIncreasePaid) {
    try {
      const details = await fetchPiicDecsn(item.corp_code, item.rcept_dt);
      const d = details[0] || {};
      capitalIncreasePaid.push({
        corp_name: item.corp_name,
        stock_code: item.stock_code,
        rcept_no: item.rcept_no,
        rcept_dt: item.rcept_dt,
        method: d.ic_mthn || null, // 증자방식 (제3자배정/일반공모/주주배정 등)
        new_shares: d.nstk_ostk_cnt || null, // 신주의 종류와 수(보통주)
        record_date: d.nstk_asstd || null, // 주주배정 방식일 때만 제공됨
        dart_url: dartUrl(item.rcept_no),
      });
    } catch (e) {
      capitalIncreasePaid.push({ corp_name: item.corp_name, stock_code: item.stock_code, rcept_no: item.rcept_no, rcept_dt: item.rcept_dt, dart_url: dartUrl(item.rcept_no), error: String(e.message || e) });
    }
  }

  const capitalIncreaseFree = [];
  for (const item of buckets.capitalIncreaseFree) {
    try {
      const details = await fetchFricDecsn(item.corp_code, item.rcept_dt);
      const d = details[0] || {};
      capitalIncreaseFree.push({
        corp_name: item.corp_name,
        stock_code: item.stock_code,
        rcept_no: item.rcept_no,
        rcept_dt: item.rcept_dt,
        record_date: d.nstk_asstd || null, // 신주배정기준일
        ratio_per_share: d.nstk_ascnt_ps_ostk || null, // 1주당 배정주식수
        listing_date: d.nstk_lstprd || null, // 신주 상장 예정일
        dart_url: dartUrl(item.rcept_no),
      });
    } catch (e) {
      capitalIncreaseFree.push({ corp_name: item.corp_name, stock_code: item.stock_code, rcept_no: item.rcept_no, rcept_dt: item.rcept_dt, dart_url: dartUrl(item.rcept_no), error: String(e.message || e) });
    }
  }

  const convertibleBond = [];
  for (const item of buckets.convertibleBond) {
    try {
      const details = await fetchCvbdIsDecsn(item.corp_code, item.rcept_dt);
      const d = details[0] || {};
      convertibleBond.push({
        corp_name: item.corp_name,
        stock_code: item.stock_code,
        rcept_no: item.rcept_no,
        rcept_dt: item.rcept_dt,
        conversion_price: d.cv_prc || null,
        conversion_start: d.cvrqpd_bgd || null, // 전환청구기간 시작
        conversion_end: d.cvrqpd_edd || null, // 전환청구기간 종료
        pay_date: d.pymd || null, // 납입(예정)일
        maturity_date: d.bd_mtd || null, // 만기일
        dart_url: dartUrl(item.rcept_no),
      });
    } catch (e) {
      convertibleBond.push({ corp_name: item.corp_name, stock_code: item.stock_code, rcept_no: item.rcept_no, rcept_dt: item.rcept_dt, dart_url: dartUrl(item.rcept_no), error: String(e.message || e) });
    }
  }

  const treasuryStock = [];
  for (const item of buckets.treasuryStockAcquire) {
    try {
      const details = await fetchTsstkAqDecsn(item.corp_code, item.rcept_dt);
      const d = details[0] || {};
      treasuryStock.push({
        corp_name: item.corp_name,
        stock_code: item.stock_code,
        rcept_no: item.rcept_no,
        rcept_dt: item.rcept_dt,
        type: '취득',
        period_start: d.aqexpd_bgd || null,
        period_end: d.aqexpd_edd || null,
        purpose: d.aq_pp || null,
        method: d.aq_mth || null,
        dart_url: dartUrl(item.rcept_no),
      });
    } catch (e) {
      treasuryStock.push({ corp_name: item.corp_name, stock_code: item.stock_code, rcept_no: item.rcept_no, rcept_dt: item.rcept_dt, type: '취득', dart_url: dartUrl(item.rcept_no), error: String(e.message || e) });
    }
  }
  for (const item of buckets.treasuryStockDispose) {
    try {
      const details = await fetchTsstkDpDecsn(item.corp_code, item.rcept_dt);
      const d = details[0] || {};
      treasuryStock.push({
        corp_name: item.corp_name,
        stock_code: item.stock_code,
        rcept_no: item.rcept_no,
        rcept_dt: item.rcept_dt,
        type: '처분',
        period_start: d.dpprpd_bgd || null,
        period_end: d.dpprpd_edd || null,
        purpose: d.dp_pp || null,
        method: null,
        dart_url: dartUrl(item.rcept_no),
      });
    } catch (e) {
      treasuryStock.push({ corp_name: item.corp_name, stock_code: item.stock_code, rcept_no: item.rcept_no, rcept_dt: item.rcept_dt, type: '처분', dart_url: dartUrl(item.rcept_no), error: String(e.message || e) });
    }
  }
  treasuryStock.sort((a, b) => b.rcept_dt.localeCompare(a.rcept_dt));

  const insiderPlan = buckets.insiderPlan.map((item) => ({
    corp_name: item.corp_name,
    stock_code: item.stock_code,
    rcept_no: item.rcept_no,
    rcept_dt: item.rcept_dt,
    flr_nm: item.flr_nm,
    dart_url: dartUrl(item.rcept_no),
  }));

  await writeJson('dart-capital-increase-paid.json', { updated_at: new Date().toISOString(), range: { from: BGN, to: TODAY }, items: capitalIncreasePaid });
  await writeJson('dart-capital-increase-free.json', { updated_at: new Date().toISOString(), range: { from: BGN, to: TODAY }, items: capitalIncreaseFree });
  await writeJson('dart-convertible-bond.json', { updated_at: new Date().toISOString(), range: { from: BGN, to: TODAY }, items: convertibleBond });
  await writeJson('dart-treasury-stock.json', { updated_at: new Date().toISOString(), range: { from: BGN, to: TODAY }, items: treasuryStock });
  await writeJson('dart-insider-plan.json', { updated_at: new Date().toISOString(), range: { from: BGN, to: TODAY }, items: insiderPlan });

  console.log('[dart] 완료:', {
    capitalIncreasePaid: capitalIncreasePaid.length,
    capitalIncreaseFree: capitalIncreaseFree.length,
    convertibleBond: convertibleBond.length,
    treasuryStock: treasuryStock.length,
    insiderPlan: insiderPlan.length,
  });
}

main().catch((e) => {
  console.error('[dart] 실패:', e);
  process.exit(1);
});
