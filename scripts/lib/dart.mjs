const BASE = 'https://opendart.fss.or.kr/api';

function apiKey() {
  const key = process.env.DART_API_KEY;
  if (!key) throw new Error('DART_API_KEY 환경변수가 설정되지 않았습니다.');
  return key;
}

async function fetchWithRetry(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      return res;
    } catch (e) {
      clearTimeout(timer);
      if (attempt === retries) throw new Error(e.name === 'AbortError' ? '요청 시간초과(15s)' : e.message);
      console.warn(`[dart] 연결 실패, 재시도 ${attempt}/${retries}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

async function callJson(path, params) {
  const url = new URL(`${BASE}/${path}`);
  url.searchParams.set('crtfc_key', apiKey());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`DART API HTTP ${res.status}: ${path}`);
  const data = await res.json();
  if (data.status !== '000' && data.status !== '013') {
    // 013 = 조회된 데이터가 없습니다 (정상 케이스로 취급)
    throw new Error(`DART API 오류 ${data.status}: ${data.message} (${path})`);
  }
  return data;
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * 지정한 날짜 범위의 전체 공시 목록을 모두 페이지네이션하여 가져온다.
 * (report_nm 텍스트 검색 API가 없어, 전체를 받아 클라이언트에서 키워드로 분류한다)
 */
export async function fetchAllDisclosures(bgnDe, endDe) {
  const list = [];
  let page = 1;
  const pageCount = 100;
  while (true) {
    const data = await callJson('list.json', {
      bgn_de: bgnDe,
      end_de: endDe,
      page_no: String(page),
      page_count: String(pageCount),
    });
    if (data.status === '013' || !data.list) break;
    list.push(...data.list);
    if (page >= (data.total_page || 1)) break;
    page += 1;
    // DART 요청 제한 보호용 소폭 지연
    await new Promise((r) => setTimeout(r, 150));
  }
  return list;
}

export async function fetchPiicDecsn(corpCode, deDay) {
  const data = await callJson('piicDecsn.json', { corp_code: corpCode, bgn_de: deDay, end_de: deDay });
  return data.list || [];
}

export async function fetchFricDecsn(corpCode, deDay) {
  const data = await callJson('fricDecsn.json', { corp_code: corpCode, bgn_de: deDay, end_de: deDay });
  return data.list || [];
}

export async function fetchCvbdIsDecsn(corpCode, deDay) {
  const data = await callJson('cvbdIsDecsn.json', { corp_code: corpCode, bgn_de: deDay, end_de: deDay });
  return data.list || [];
}

export async function fetchTsstkAqDecsn(corpCode, deDay) {
  const data = await callJson('tsstkAqDecsn.json', { corp_code: corpCode, bgn_de: deDay, end_de: deDay });
  return data.list || [];
}

export async function fetchTsstkDpDecsn(corpCode, deDay) {
  const data = await callJson('tsstkDpDecsn.json', { corp_code: corpCode, bgn_de: deDay, end_de: deDay });
  return data.list || [];
}

export { fmtDate };
