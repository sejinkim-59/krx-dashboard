// 한국투자증권 KIS Open API 클라이언트.
// 공식 샘플(github.com/koreainvestment/open-trading-api)에서 확인한 endpoint/tr_id/field만 사용한다.
// - OAuth2 토큰: POST /oauth2/tokenP {grant_type, appkey, appsecret} -> { access_token, access_token_token_expired }
//   (KIS 서버가 6시간 이내 재요청 시 기존 토큰을 그대로 돌려주므로, 매 실행(cron)마다 새로 발급받아도 안전하다.
//    단, 프로세스 내에서는 한 번만 발급받아 재사용한다. access_token은 파일에 절대 저장하지 않는다.)
// - 국내주식 현재가: GET /uapi/domestic-stock/v1/quotations/inquire-price (tr_id FHKST01010100)
// - 국내주식 기간별시세: GET /uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice (tr_id FHKST03010100)
// 실시간 WebSocket(ws://ops.koreainvestment.com)은 평문 소켓이라 https 페이지(GitHub Pages)에서
// 브라우저가 mixed-content로 차단하고, 이 프로젝트엔 상시 구동 서버도 없어 이번 구현에는 포함하지 않는다.

const BASE = process.env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443';

function credentials() {
  const appKey = process.env.KIS_APP_KEY;
  const appSecret = process.env.KIS_APP_SECRET;
  if (!appKey || !appSecret) throw new Error('KIS_APP_KEY/KIS_APP_SECRET 환경변수가 설정되지 않았습니다.');
  return { appKey, appSecret };
}

async function fetchWithRetry(url, options = {}, retries = 4) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      // KIS는 초당 거래건수 초과 시 500을 돌려주는 경우가 있다 — 백오프 후 재시도.
      if (res.status >= 500 && attempt < retries) {
        console.warn(`[kis] HTTP ${res.status} (rate limit 추정), 재시도 ${attempt}/${retries}`);
        await new Promise((r) => setTimeout(r, 800 * attempt));
        continue;
      }
      return res;
    } catch (e) {
      clearTimeout(timer);
      if (attempt === retries) throw new Error(e.name === 'AbortError' ? '요청 시간초과(15s)' : e.message);
      console.warn(`[kis] 연결 실패, 재시도 ${attempt}/${retries}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

// 동시에 여러 곳에서 호출해도 토큰 발급 요청이 중복되지 않도록 in-flight promise를 공유한다.
// 프로세스 메모리에만 두고 어떤 파일에도 쓰지 않는다.
let tokenPromise = null;

async function getAccessToken() {
  if (tokenPromise) return tokenPromise;
  tokenPromise = (async () => {
    const { appKey, appSecret } = credentials();
    const res = await fetchWithRetry(`${BASE}/oauth2/tokenP`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ grant_type: 'client_credentials', appkey: appKey, appsecret: appSecret }),
    });
    if (!res.ok) throw new Error(`KIS 토큰 발급 실패: HTTP ${res.status}`);
    const data = await res.json();
    if (!data.access_token) throw new Error('KIS 토큰 응답에 access_token이 없습니다.');
    return data.access_token;
  })();
  try {
    return await tokenPromise;
  } catch (e) {
    tokenPromise = null; // 실패 시 다음 호출에서 재시도 가능하도록 초기화
    throw e;
  }
}

function authHeaders(token, trId, appKey, appSecret) {
  return {
    authorization: `Bearer ${token}`,
    appkey: appKey,
    appsecret: appSecret,
    tr_id: trId,
    custtype: 'P',
    'content-type': 'application/json; charset=utf-8',
  };
}

/** 국내주식 현재가 시세 (FHKST01010100). symbol: 6자리 종목코드. */
export async function fetchQuote(symbol) {
  const { appKey, appSecret } = credentials();
  const token = await getAccessToken();
  const url = new URL(`${BASE}/uapi/domestic-stock/v1/quotations/inquire-price`);
  url.searchParams.set('FID_COND_MRKT_DIV_CODE', 'J');
  url.searchParams.set('FID_INPUT_ISCD', symbol);
  const res = await fetchWithRetry(url, { headers: authHeaders(token, 'FHKST01010100', appKey, appSecret) });
  if (!res.ok) throw new Error(`KIS 현재가 조회 실패: HTTP ${res.status} (${symbol})`);
  const data = await res.json();
  if (data.rt_cd !== '0') throw new Error(`KIS 현재가 조회 오류 ${data.rt_cd}: ${data.msg1 || ''} (${symbol})`);
  return data.output;
}

/**
 * 국내주식 기간별시세(일/주/월/년) (FHKST03010100).
 * from/to: YYYYMMDD. periodDiv: 'D'|'W'|'M'|'Y'.
 */
export async function fetchDailyOhlcv(symbol, { from, to, periodDiv = 'D' } = {}) {
  const { appKey, appSecret } = credentials();
  const token = await getAccessToken();
  const url = new URL(`${BASE}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice`);
  url.searchParams.set('FID_COND_MRKT_DIV_CODE', 'J');
  url.searchParams.set('FID_INPUT_ISCD', symbol);
  url.searchParams.set('FID_INPUT_DATE_1', from);
  url.searchParams.set('FID_INPUT_DATE_2', to);
  url.searchParams.set('FID_PERIOD_DIV_CODE', periodDiv);
  url.searchParams.set('FID_ORG_ADJ_PRC', '0');
  const res = await fetchWithRetry(url, { headers: authHeaders(token, 'FHKST03010100', appKey, appSecret) });
  if (!res.ok) throw new Error(`KIS 기간별시세 조회 실패: HTTP ${res.status} (${symbol})`);
  const data = await res.json();
  if (data.rt_cd !== '0') throw new Error(`KIS 기간별시세 조회 오류 ${data.rt_cd}: ${data.msg1 || ''} (${symbol})`);
  return data.output2 || [];
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// KIS 응답(전부 문자열)을 공통 Quote 모델로 정규화한다. 없는 값은 null로 두고 지어내지 않는다.
export function normalizeQuote(inst, o) {
  const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
  return {
    symbol: inst.symbol,
    name: inst.name,
    market: inst.market || o.rprs_mrkt_kor_name || null,
    sector: inst.sector || o.bstp_kor_isnm || null,
    currency: 'KRW',
    price: num(o.stck_prpr),
    change: num(o.prdy_vrss),
    changePercent: num(o.prdy_ctrt),
    open: num(o.stck_oprc),
    high: num(o.stck_hgpr),
    low: num(o.stck_lwpr),
    previousClose: num(o.stck_sdpr),
    volume: num(o.acml_vol),
    tradingValue: num(o.acml_tr_pbmn),
    marketCap: num(o.hts_avls), // 억원 단위 (KIS 응답 그대로)
    week52High: num(o.w52_hgpr),
    week52Low: num(o.w52_lwpr),
    per: num(o.per),
    pbr: num(o.pbr),
    sharesOutstanding: num(o.lstn_stcn),
    isRealtime: false,
    source: 'KIS REST',
  };
}

// KIS output2는 최신이 먼저 온다 — 과거->최신 순으로 뒤집는다.
export function normalizeOhlcv(rows) {
  return [...rows].filter((r) => r.stck_bsop_date).reverse().map((r) => ({
    time: `${r.stck_bsop_date.slice(0, 4)}-${r.stck_bsop_date.slice(4, 6)}-${r.stck_bsop_date.slice(6, 8)}`,
    open: Number(r.stck_oprc),
    high: Number(r.stck_hgpr),
    low: Number(r.stck_lwpr),
    close: Number(r.stck_clpr),
    volume: Number(r.acml_vol),
  }));
}
