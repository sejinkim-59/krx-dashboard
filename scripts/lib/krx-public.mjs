// data.krx.co.kr / kind.krx.co.kr의 로그인 불필요 "공개(_OUT/외부)" 엔드포인트 모음.
// 일반 정보데이터시스템 통계화면(mdiLoader)은 회원 로그인이 필요하도록 바뀌었지만,
// 개별 종목 위젯(공매도)과 순매수 상위 랭킹(outerLoader)은 로그인 없이 접근 가능하다.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const KRX_BASE = 'https://data.krx.co.kr';
const KIND_BASE = 'https://kind.krx.co.kr';

async function postForm(url, referer, fields, retries = 2) {
  const body = new URLSearchParams(fields);
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': UA, Referer: referer, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`KRX public HTTP ${res.status}: ${url}`);
      return res;
    } catch (e) {
      clearTimeout(timer);
      if (attempt > retries) throw new Error(`${e.name === 'AbortError' ? '요청 시간초과(10s)' : e.message}: ${url}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

/** 종목별 공매도 거래 현황 (당일 포함, 로그인 불필요). isuCd는 12자리 표준코드(ISIN). */
export async function fetchShortSellingByIsin(isuCd, strtDd, endDd) {
  const res = await postForm(
    `${KRX_BASE}/comm/bldAttendant/getJsonData.cmd`,
    `${KRX_BASE}/comm/srt/srtLoader/index.cmd?screenId=MDCSTAT300`,
    { bld: 'dbms/MDC_OUT/STAT/srt/MDCSTAT30001_OUT', isuCd, strtDd, endDd, locale: 'ko_KR' }
  );
  const data = await res.json();
  return data.OutBlock_1 || [];
}

/** 투자자별(외국인/기관/개인 등) 순매수 상위종목. invstTpCd는 아래 fetchInvestorTypeCodes 참고. */
export async function fetchNetBuyTopByInvestorType({ mktId = 'STK', invstTpCd, strtDd, endDd }) {
  const res = await postForm(
    `${KRX_BASE}/comm/bldAttendant/getJsonData.cmd`,
    `${KRX_BASE}/contents/MDC/MDI/outerLoader/index.cmd?screenId=MDCSTAT024`,
    { bld: 'dbms/MDC_OUT/STAT/standard/MDCSTAT02401_OUT', mktId, invstTpCd, strtDd, endDd, money: '1', locale: 'ko_KR' }
  );
  const data = await res.json();
  return data.output || [];
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * 이 공개 엔드포인트는 KRX Open API와 달리 반영 지연이 거의 없어(당일 장마감 후 바로 반영),
 * 인증 API 기반 날짜 탐색보다 이 엔드포인트로 직접 거래일을 찾는 편이 더 최신 데이터를 준다.
 */
export async function findRecentPublicTradingDates(count = 8, maxLookbackDays = 20) {
  const found = [];
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  for (let i = 0; i <= maxLookbackDays && found.length < count; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const basDd = fmtDate(d);
    const rows = await fetchNetBuyTopByInvestorType({ mktId: 'STK', invstTpCd: '9999', strtDd: basDd, endDd: basDd });
    if (rows.length > 0) found.push(basDd);
    await new Promise((r) => setTimeout(r, 150));
  }
  return found;
}

/**
 * 투자주의/경고/위험 종목 지정 내역 (KIND, 로그인 불필요). HTML 테이블을 그대로 반환한다.
 * kind: 'invstcautnisu_sub' | 'invstwarnisu_sub' | 'invstriskisu_sub'
 */
export async function fetchInvestAlertHtml(kind, menuIndex, strtDd, endDd) {
  const res = await postForm(
    `${KIND_BASE}/investwarn/investattentwarnrisky.do`,
    `${KIND_BASE}/investwarn/investattentwarnrisky.do?method=investattentwarnriskyMain`,
    {
      method: 'investattentwarnriskySub',
      forward: kind,
      menuIndex: String(menuIndex),
      marketType: '',
      startDate: strtDd,
      endDate: endDd,
      searchCorpName: '',
      currentPageSize: '100',
      pageIndex: '1',
    }
  );
  return res.text();
}

/** <tr>...<td>번호</td><td>종목명</td><td>유형</td><td>공시일</td><td>지정일</td></tr> 형태를 파싱 */
export function parseInvestAlertRows(html) {
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = trRe.exec(html))) {
    const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((t) => t[1].replace(/<[^>]+>/g, '').trim());
    if (tds.length < 5) continue;
    const nameMatch = m[1].match(/title=['"]([^'"]+)['"][^>]*>\s*([^<]+)</);
    rows.push({
      no: tds[0],
      corp_name: (nameMatch?.[1] || tds[1]).trim(),
      type: tds[2],
      disclosed_date: tds[3],
      designated_date: tds[4],
    });
  }
  return rows;
}
