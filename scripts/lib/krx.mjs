const BASE = 'https://data-dbg.krx.co.kr/svc/apis';

function apiKey() {
  const key = process.env.KRX_API_KEY;
  if (!key) throw new Error('KRX_API_KEY 환경변수가 설정되지 않았습니다.');
  return key;
}

async function fetchWithRetry(url, options, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fetch(url, options);
    } catch (e) {
      if (attempt === retries) throw e;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

async function callApi(path, basDd) {
  const url = `${BASE}/${path}?basDd=${basDd}`;
  const res = await fetchWithRetry(url, { headers: { AUTH_KEY: apiKey() } });
  if (!res.ok) throw new Error(`KRX API HTTP ${res.status}: ${path}`);
  const data = await res.json();
  if (data.respCode) throw new Error(`KRX API 오류 ${data.respCode}: ${data.respMsg} (${path})`);
  return data.OutBlock_1 || [];
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * KRX Open API는 데이터 반영에 며칠 지연이 있어, 오늘부터 거슬러 올라가며
 * 실제 데이터가 있는 가장 최근 N개 날짜를 찾는다. (휴장일도 함께 건너뜀)
 */
export async function findRecentAvailableDates(path, count = 2, maxLookbackDays = 20) {
  const found = [];
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000); // KST
  for (let i = 0; i <= maxLookbackDays && found.length < count; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const basDd = fmtDate(d);
    const rows = await callApi(path, basDd);
    if (rows.length > 0) found.push({ basDd, rows });
    await new Promise((r) => setTimeout(r, 150));
  }
  if (found.length === 0) throw new Error(`${path}: 최근 ${maxLookbackDays}일 내 데이터를 찾지 못했습니다.`);
  return found;
}

export { callApi };
