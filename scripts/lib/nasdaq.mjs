const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

/** 특정 날짜(YYYY-MM-DD)에 실적을 발표한 미국 상장사 목록을 가져온다. 인증 불필요. */
export async function fetchEarningsForDate(dateStr) {
  const url = `https://api.nasdaq.com/api/calendar/earnings?date=${dateStr}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: controller.signal });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? '요청 시간초과(12s)' : e.message);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`Nasdaq earnings API HTTP ${res.status}`);
  const data = await res.json();
  return data?.data?.rows || [];
}

/** 최근 며칠간의 실적 발표 목록을 모아 반환한다. */
export async function fetchRecentEarnings(daysBack = 5) {
  const now = new Date();
  const all = [];
  for (let i = 1; i <= daysBack; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const dateStr = fmtDate(d);
    try {
      const rows = await fetchEarningsForDate(dateStr);
      for (const r of rows) all.push({ ...r, report_date: dateStr });
    } catch (e) {
      console.warn(`[nasdaq] ${dateStr} 조회 실패:`, e.message);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return all;
}

export function parseMarketCap(v) {
  if (!v) return null;
  const n = Number(String(v).replace(/[$,]/g, ''));
  return Number.isNaN(n) ? null : n;
}
