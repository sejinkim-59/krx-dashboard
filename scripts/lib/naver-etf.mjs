const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

/** 국내 상장 ETF 전체 목록 (시세 포함). 응답이 EUC-KR이라 별도 디코딩이 필요하다. */
export async function fetchAllEtfList() {
  const res = await fetch('https://finance.naver.com/api/sise/etfItemList.nhn', { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Naver ETF 목록 요청 실패: ${res.status}`);
  const buf = await res.arrayBuffer();
  const text = new TextDecoder('euc-kr').decode(buf);
  const data = JSON.parse(text);
  return data.result?.etfItemList || [];
}

/** 종목코드로 국내 섹터/테마 ETF만 추립니다 (해외 지수 추종 ETF 제외). */
export function pickDomesticThemeEtfs(items, { keywords, exclude, topN }) {
  const matched = items.filter(
    (it) => keywords.some((k) => it.itemname.includes(k)) && !exclude.some((e) => it.itemname.includes(e))
  );
  matched.sort((a, b) => b.marketSum - a.marketSum);
  return matched.slice(0, topN);
}

/** ETF 1종목의 CU(구성종목) 보유 현황. UTF-8, 로그인 불필요. */
export async function fetchEtfHoldings(code) {
  const res = await fetch(`https://navercomp.wisereport.co.kr/v2/ETF/index.aspx?cmp_cd=${code}`, {
    headers: { 'User-Agent': UA },
  });
  if (!res.ok) throw new Error(`ETF 보유내역 요청 실패 (${code}): ${res.status}`);
  const html = await res.text();
  const m = html.match(/CU_data\s*=\s*(\{[\s\S]*?\});/);
  if (!m) return { trdDt: null, holdings: [] };
  const parsed = JSON.parse(m[1]);
  const grid = parsed.grid_data || [];
  return {
    trdDt: grid[0]?.TRD_DT || null,
    holdings: grid.map((g) => ({ name: g.STK_NM_KOR, weight: g.ETF_WEIGHT, shares: g.AGMT_STK_CNT })),
  };
}
