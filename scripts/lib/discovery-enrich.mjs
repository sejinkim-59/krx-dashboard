// Discovery Enrichment — 관심종목(대형주 위주) 밖에서 새 후보를 찾기 위한 2단계 수집.
// ① Pre-screen: 가격 없이 수급(외국인/기관/연기금 매수 전환·순매수 상위)과 DART 이벤트만으로 저비용 선별
// ② Enrich: 상위 N개만 KIS 현재가 + 일봉을 추가 조회해 Novelty/Technical/Priced-in 평가가 가능하게 한다.
// 절대 순매수 금액은 선별 순서에도 쓰지 않는다 (대형주 편향 방지).

import { fetchQuote, fetchDailyOhlcv, normalizeQuote, normalizeOhlcv, sleep } from './kis.mjs';
import { DISCOVERY_CONFIG, DIRECTIONAL_INVESTORS } from './selection-config.mjs';

export function preScreen(universe, d) {
  const known = new Set((d.kisQuotes?.items || []).map((q) => q.symbol));
  const score = new Map();
  const bump = (symbol, pts, tag) => {
    if (!universe.has(symbol) || known.has(symbol)) return;
    const name = universe.get(symbol);
    if (DISCOVERY_CONFIG.excludeNamePattern.test(name)) return;
    const cur = score.get(symbol) || { symbol, name, points: 0, tags: new Set(), buyInvestors: new Set() };
    cur.points += pts;
    cur.tags.add(tag);
    score.set(symbol, cur);
    return cur;
  };

  for (const [code, inv] of Object.entries(d.investorFlow?.investors || {})) {
    if (!DIRECTIONAL_INVESTORS[code]) continue; // 개인 단독 신호로는 후보에 올리지 않는다
    for (const f of inv.flips || []) {
      if (f.recent_net > 0) bump(f.symbol, 2, 'flow_reversal_buy')?.buyInvestors.add(code);
    }
    (inv.top_net_buy || []).slice(0, 100).forEach((t) => bump(t.symbol, 1, 'flow_top_buy')?.buyInvestors.add(code));
  }
  // 긍정 방향 이벤트만 (CB·유상증자·자사주 처분은 공급 이벤트라 Discovery 후보 사유가 아님)
  const lastReaction = (r) => { const v = Object.entries(r || {}).filter(([k, x]) => x != null && k !== 'D-1'); return v.length ? v[v.length - 1][1] : null; };
  for (const it of d.capitalIncreaseFree?.items || []) if (it.stock_code) bump(it.stock_code, 2, 'positive_event');
  for (const it of d.treasuryStock?.items || []) if (it.stock_code && it.type === '취득') bump(it.stock_code, 2, 'positive_event');
  for (const it of d.krEarnings?.items || []) if (it.stock_code && (lastReaction(it.reaction) ?? 0) > 0) bump(it.stock_code, 2, 'positive_event');
  // 서로 다른 방향성 투자주체가 동시에 매수 쪽이면 가산 (독립 확인의 사전 신호)
  for (const s of score.values()) if (s.buyInvestors.size >= 2) s.points += s.buyInvestors.size - 1;

  return [...score.values()]
    .sort((a, b) => b.points - a.points || b.tags.size - a.tags.size || a.symbol.localeCompare(b.symbol))
    .map((s) => ({ symbol: s.symbol, name: s.name, points: s.points, tags: [...s.tags] }));
}

/** 조회 예산 배분: 이벤트 종목 예약분 + 나머지는 종합 순위. */
export function allocateEnrichment(ranked, limit = DISCOVERY_CONFIG.enrichLimit, reserved = DISCOVERY_CONFIG.enrichReservedForEvents) {
  const events = ranked.filter((c) => c.tags.includes('positive_event')).slice(0, reserved);
  const picked = new Set(events.map((c) => c.symbol));
  const rest = ranked.filter((c) => !picked.has(c.symbol)).slice(0, limit - events.length);
  return [...rest, ...events];
}

function ymd(dt) {
  return dt.toISOString().slice(0, 10).replace(/-/g, '');
}

/** 과거 선정 종목 중 D+20 성과가 아직 안 채워진 종목의 일봉만 추가 조회 (Learning Desk 성과 추적용). */
export async function fetchTrackingOhlcv(symbols) {
  const ohlcv = {}, errors = [];
  const to = new Date();
  const from = new Date(to.getTime() - 200 * 86400000);
  for (const symbol of symbols) {
    try {
      ohlcv[symbol] = normalizeOhlcv(await fetchDailyOhlcv(symbol, { from: ymd(from), to: ymd(to) }));
    } catch (e) {
      errors.push(`track:${symbol}: ${e.message}`);
    }
    await sleep(DISCOVERY_CONFIG.enrichDelayMs);
  }
  return { ohlcv, errors };
}

export async function enrich(candidates) {
  const quotes = [], ohlcv = {}, errors = [];
  const to = new Date();
  const from = new Date(to.getTime() - 200 * 86400000);
  for (const c of candidates) {
    try {
      const o = await fetchQuote(c.symbol);
      quotes.push({ ...normalizeQuote({ symbol: c.symbol, name: c.name }, o), discovery: true, preScreen: { points: c.points, tags: c.tags } });
    } catch (e) {
      errors.push(`quote:${c.symbol}: ${e.message}`);
    }
    await sleep(DISCOVERY_CONFIG.enrichDelayMs);
    try {
      ohlcv[c.symbol] = normalizeOhlcv(await fetchDailyOhlcv(c.symbol, { from: ymd(from), to: ymd(to) }));
    } catch (e) {
      errors.push(`ohlcv:${c.symbol}: ${e.message}`);
    }
    await sleep(DISCOVERY_CONFIG.enrichDelayMs);
  }
  return { quotes, ohlcv, errors };
}
