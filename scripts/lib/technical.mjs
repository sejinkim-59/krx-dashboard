// 순수 기술적 지표 계산. OHLCV bar 배열(과거->최신)만 입력으로 받는다.
// 데이터가 부족해 계산 불가능한 지표는 null을 반환한다 — 0으로 지어내지 않는다.
// 주의: KIS 1회 조회는 최대 100건이라 MA120처럼 120봉이 필요한 지표는
// 현재 수집 범위(~100영업일)에서는 대부분 null이 된다. 이는 실제 데이터 한계이며
// Data Coverage 계산에 그대로 반영된다 (지어내서 채우지 않음).

function sma(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/** period일 전 대비 현재 종가 수익률(%) */
function returnPct(closes, period) {
  if (closes.length < period + 1) return null;
  const past = closes[closes.length - 1 - period];
  const now = closes[closes.length - 1];
  if (!past) return null;
  return ((now - past) / past) * 100;
}

/** MA의 방향(기울기)을 최근 5봉 MA 변화로 판단 — 절대 레벨이 아니라 추세 판단용. */
function maSlopeSign(closes, period, lookback = 5) {
  if (closes.length < period + lookback) return null;
  const maNow = sma(closes, period);
  const maPast = sma(closes.slice(0, closes.length - lookback), period);
  if (maNow == null || maPast == null) return null;
  return maNow > maPast ? 1 : maNow < maPast ? -1 : 0;
}

function rsi14(closes) {
  const period = 14;
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function atr14(bars) {
  const period = 14;
  if (bars.length < period + 1) return null;
  const trs = [];
  for (let i = bars.length - period; i < bars.length; i++) {
    const cur = bars[i], prev = bars[i - 1];
    const tr = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
    trs.push(tr);
  }
  return trs.reduce((a, b) => a + b, 0) / period;
}

/** 최근 N봉 중 최고가 대비 현재 종가의 거리(%). 0 = 신고가, 음수 = 그만큼 아래. */
function distanceFromHighPct(bars, period) {
  if (bars.length < period) return null;
  const slice = bars.slice(-period);
  const highest = Math.max(...slice.map((b) => b.high));
  const close = bars[bars.length - 1].close;
  return ((close - highest) / highest) * 100;
}

function smaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * a가 b를 아래→위로 넘은 가장 최근 시점. 현재도 a > b 상태가 유지될 때만 유효한 변화로 본다
 * (돌파 후 다시 이탈했으면 그 변화는 무효).
 */
function mostRecentCrossUp(a, b, bars) {
  const last = bars.length - 1;
  if (a[last] == null || b[last] == null || !(a[last] > b[last])) return null;
  for (let i = last; i >= 1; i--) {
    if (a[i] == null || b[i] == null || a[i - 1] == null || b[i - 1] == null) return null;
    if (a[i - 1] <= b[i - 1] && a[i] > b[i]) {
      return { previousState: 'below', currentState: 'above', changeDate: bars[i].time, daysSinceChange: last - i };
    }
  }
  return null;
}

/** 직전 20봉 평균 대비 ratio 이상 거래량이 "새로" 나타난 가장 최근 날 (전날은 기준 미달이어야 함). */
function mostRecentVolumeSpike(bars, ratio) {
  const last = bars.length - 1;
  const ratioAt = (i) => {
    if (i < 20) return null;
    let s = 0;
    for (let j = i - 20; j < i; j++) s += bars[j].volume;
    const avg = s / 20;
    return avg > 0 ? bars[i].volume / avg : null;
  };
  for (let i = last; i >= 21; i--) {
    const r = ratioAt(i);
    if (r != null && r >= ratio) {
      const prev = ratioAt(i - 1);
      if (prev != null && prev < ratio) {
        return { previousState: 'normal', currentState: `${r.toFixed(1)}x`, changeDate: bars[i].time, daysSinceChange: last - i, ratio: r };
      }
    }
  }
  return null;
}

/** State가 아니라 Change를 찾는다. 각 이벤트: {previousState,currentState,changeDate,daysSinceChange} 또는 null. */
export function detectChangeEvents(bars, volumeSpikeRatio = 2.0) {
  if (!bars || bars.length < 25) return null;
  const closes = bars.map((b) => b.close);
  const ma20 = smaSeries(closes, 20);
  const ma60 = bars.length >= 62 ? smaSeries(closes, 60) : null;
  const last = bars.length - 1;
  // 변화 발생 전날 종가 대비 현재까지 수익률 — "이미 반영됐나"를 이벤트 단위로 판단하기 위함
  const withReturn = (ev) => {
    if (!ev) return null;
    const i = last - ev.daysSinceChange;
    const base = i > 0 ? closes[i - 1] : null;
    return { ...ev, returnSinceChange: base ? ((closes[last] - base) / base) * 100 : null };
  };
  return {
    ma20CrossAboveMa60: withReturn(ma60 ? mostRecentCrossUp(ma20, ma60, bars) : null),
    ma20CrossAboveMa60Evaluable: !!ma60,
    priceCrossAboveMa20: withReturn(mostRecentCrossUp(closes, ma20, bars)),
    volumeSpike: withReturn(mostRecentVolumeSpike(bars, volumeSpikeRatio)),
  };
}

/** bars: [{time,open,high,low,close,volume}] 과거->최신 순. week52High: kis-quotes의 실제 52주 최고가(있으면 우선 사용). */
export function computeFeatures(bars, week52High) {
  if (!bars || bars.length < 6) return null;
  const closes = bars.map((b) => b.close);
  const last = bars[bars.length - 1];
  const vol20 = bars.length >= 21 ? bars.slice(-21, -1).reduce((s, b) => s + b.volume, 0) / 20 : null;

  return {
    close: last.close,
    open: last.open,
    high: last.high,
    low: last.low,
    ma5: sma(closes, 5),
    ma20: sma(closes, 20),
    ma60: sma(closes, 60),
    ma120: sma(closes, 120),
    ma20Slope: maSlopeSign(closes, 20),
    ma60Slope: maSlopeSign(closes, 60),
    return5D: returnPct(closes, 5),
    return20D: returnPct(closes, 20),
    return60D: returnPct(closes, 60),
    dist20DHigh: distanceFromHighPct(bars, 20),
    dist52WHigh: week52High ? ((last.close - week52High) / week52High) * 100 : distanceFromHighPct(bars, bars.length),
    rsi14: rsi14(closes),
    atr14: atr14(bars),
    volume: last.volume,
    volume20DAvg: vol20,
    volumeRatio: vol20 ? last.volume / vol20 : null,
  };
}
