const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * 여러 종목의 최근 종가 히스토리를 배치로 가져온다 (심볼당 개별 요청보다 훨씬 빠름).
 * 반환: { SYMBOL: { closes: number[], timestamps: number[] } }
 */
export async function fetchSparkBatch(symbols, range = '3mo') {
  const result = {};
  // 심볼 20개 초과 배치는 Yahoo가 400을 반환하는 경우가 있어 20개 단위로 제한
  for (const group of chunk(symbols, 20)) {
    const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${group.join(',')}&range=${range}&interval=1d`;
    let res;
    try {
      res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) {
        // 일시적 오류일 수 있으므로 한 번 재시도
        await new Promise((r) => setTimeout(r, 800));
        res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA } });
      }
    } catch (e) {
      console.warn(`[yahoo] spark 요청 실패 (${e.message}): ${group.join(',')}`);
      continue;
    }
    if (!res.ok) {
      console.warn(`[yahoo] spark 요청 실패 (${res.status}): ${group.join(',')}`);
      continue;
    }
    const data = await res.json();
    for (const item of data?.spark?.result || []) {
      const r = item.response?.[0];
      if (!r) continue;
      result[item.symbol] = {
        closes: r.indicators?.quote?.[0]?.close || r.close || [],
        timestamps: r.timestamp || [],
      };
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return result;
}

/**
 * 단일 종목의 일별 OHLC 히스토리 (특정 기간 전후 분석용).
 */
export async function fetchDailyHistory(symbol, range = '1y') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  let res;
  try {
    res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA } });
  } catch (e) {
    throw new Error(`Yahoo chart 요청 실패 (${e.message}): ${symbol}`);
  }
  if (!res.ok) throw new Error(`Yahoo chart 요청 실패 (${res.status}): ${symbol}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo chart 데이터 없음: ${symbol}`);
  const quote = result.indicators?.quote?.[0] || {};
  return {
    symbol,
    timestamps: result.timestamp || [],
    close: quote.close || [],
    open: quote.open || [],
    high: quote.high || [],
    low: quote.low || [],
    volume: quote.volume || [],
    meta: result.meta,
  };
}

export function tsToDateStr(ts) {
  // ts: unix seconds (UTC) -> 미국 동부시간 기준 날짜 (거래일 매칭용, 단순화를 위해 UTC 날짜 사용)
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

/**
 * 특정 기준일(anchorDateStr) 이후 첫 거래일을 D0로 놓고, D-1~D+offsetMax의
 * D-1 종가 대비 누적 수익률(%)을 계산한다. (실적 발표 전후 반응 분석용)
 */
export function computeReactionSeries(hist, anchorDateStr, offsetMax = 2) {
  const dateIndex = new Map();
  hist.timestamps.forEach((ts, i) => dateIndex.set(tsToDateStr(ts), i));
  const sortedDates = Array.from(dateIndex.keys()).sort();
  let d0Idx = null;
  for (const d of sortedDates) {
    if (d >= anchorDateStr) {
      d0Idx = dateIndex.get(d);
      break;
    }
  }
  if (d0Idx == null || d0Idx < 1) return null;
  const base = hist.close[d0Idx - 1];
  if (!base) return null;
  const out = {};
  for (let off = -1; off <= offsetMax; off++) {
    const label = off === 0 ? 'D0' : off < 0 ? `D${off}` : `D+${off}`;
    const price = hist.close[d0Idx + off];
    out[label] = price != null ? +(((price - base) / base) * 100).toFixed(2) : null;
  }
  return out;
}
