// Catalyst Engine — 향후 ~20거래일 안에 "확인 가능한" 이벤트와, 이벤트의 경제적 크기.
// 공시 존재만으로 점수를 주지 않는다. 날짜로 timing을 확인하거나 비율로 크기를 계산할 수 있을 때만 점수화.

import {
  CATALYST_TIMING_RULES, CATALYST_WEIGHTS, CATALYST_WINDOW_BUSINESS_DAYS, EARNINGS_RECENT_BUSINESS_DAYS,
  EARNINGS_REACTION_MIN_PCT, NEW_FILING_BUSINESS_DAYS, PEER_EARNINGS_RECENT_BUSINESS_DAYS, PEER_SURPRISE_MIN_PCT,
  CORPORATE_RULES, EVENT_THRESHOLDS, GLOBAL_MAPPING,
} from './selection-config.mjs';
import { scoreRules, parseKoreanDate, parseYyyymmdd, businessDaysBetween, sgn } from './scoring-utils.mjs';

const find = (file, symbol) => (file?.items || []).filter((it) => it.stock_code === symbol);
const within = (days, max = CATALYST_WINDOW_BUSINESS_DAYS) => days != null && days >= 0 && days <= max;
const cumReaction = (reaction) => {
  const vals = Object.entries(reaction || {}).filter(([k, v]) => v != null && k !== 'D-1').map(([, v]) => v);
  return vals.length ? vals[vals.length - 1] : null; // D-1 대비 누적 수익률이므로 마지막 값이 누적치
};

/**
 * timing 계열. catalysts[]는 점수와 무관하게 "앞으로 확인할 일정/새로 나온 사실" 목록으로 그대로 출력한다.
 * 각 항목: {type,label,daysUntil(음수=이미 지남),filedDaysAgo,direction,source}
 */
export function evalCatalystTiming(symbol, name, d, today = new Date()) {
  const checks = {};
  const catalysts = [];
  const filed = (rcept) => businessDaysBetween(parseYyyymmdd(rcept), today);

  for (const it of find(d.capitalIncreaseFree, symbol)) {
    const rec = businessDaysBetween(today, parseKoreanDate(it.record_date));
    const lst = businessDaysBetween(today, parseKoreanDate(it.listing_date));
    checks.freeIncreaseRecordNear = checks.freeIncreaseRecordNear || within(rec) || within(lst);
    catalysts.push({ type: 'Corporate Action', label: `무상증자 1주당 ${it.ratio_per_share}주 — 배정기준일 ${it.record_date ?? '-'}, 신주상장 ${it.listing_date ?? '-'}`, daysUntil: within(rec) ? rec : lst, filedDaysAgo: filed(it.rcept_dt), direction: 'positive', source: 'DART' });
  }
  for (const it of find(d.treasuryStock, symbol)) {
    const start = parseKoreanDate(it.period_start), end = parseKoreanDate(it.period_end);
    const active = !!(start && end && businessDaysBetween(start, today) >= -1 && today <= end);
    if (it.type === '취득') checks.buybackInProgress = checks.buybackInProgress || active;
    catalysts.push({ type: it.type === '취득' ? 'Share Buyback' : 'Share Disposal', label: `자사주 ${it.type} ${it.period_start ?? ''} ~ ${it.period_end ?? ''} (${it.method || '방식 미상'})`, daysUntil: businessDaysBetween(today, start), filedDaysAgo: filed(it.rcept_dt), direction: it.type === '취득' ? 'positive' : 'supply', source: 'DART' });
  }
  for (const it of find(d.convertibleBond, symbol)) {
    const days = businessDaysBetween(today, parseKoreanDate(it.conversion_start));
    catalysts.push({ type: 'CB Conversion', label: `CB 전환청구 개시 ${it.conversion_start ?? '-'} (전환가 ${it.conversion_price ?? '-'}원) — 잠재 매도물량`, daysUntil: days, filedDaysAgo: filed(it.rcept_dt), direction: 'supply', source: 'DART' });
  }
  for (const it of find(d.krEarnings, symbol)) {
    const since = filed(it.rcept_dt);
    const cum = cumReaction(it.reaction);
    const ok = since != null && since <= EARNINGS_RECENT_BUSINESS_DAYS && cum != null && cum >= EARNINGS_REACTION_MIN_PCT;
    checks.earningsReactionRecent = checks.earningsReactionRecent || ok;
    catalysts.push({ type: 'Earnings', label: `실적 공시(${it.rcept_dt}) 후 누적 ${cum != null ? `${sgn(cum)}${cum.toFixed(1)}%` : '반응 미집계'}`, daysUntil: since != null ? -since : null, filedDaysAgo: since, direction: cum > 0 ? 'positive' : cum < 0 ? 'negative' : 'neutral', source: 'DART+KRX', reactionPct: cum });
  }
  for (const it of find(d.insiderPlan, symbol)) {
    catalysts.push({ type: 'Insider Plan', label: `내부자 거래계획 제출 (${it.flr_nm}) — 매수/매도 방향·규모 미수집, 점수 미반영`, daysUntil: null, filedDaysAgo: filed(it.rcept_dt), direction: 'unknown', source: 'DART' });
  }
  // ETF 구성 변화는 종목명으로만 제공된다 — 정확히 일치하는 이름만 연결(오매칭 방지).
  for (const etf of d.etfRebalance?.items || []) {
    const hit = (etf.added || []).find((h) => h.name === name) || (etf.changed || []).find((h) => h.name === name && h.delta > 0);
    if (hit) {
      checks.etfInclusion = true;
      catalysts.push({ type: 'ETF Rebalance', label: `${etf.name} ${hit.delta != null ? `비중 +${hit.delta}%p` : `신규 편입 (${hit.weight}%)`} (${etf.trd_dt})`, daysUntil: 0, filedDaysAgo: 0, direction: 'positive', source: 'ETF PDF' });
    }
  }
  // 해외 Peer: 매핑이 있고, 그 Peer가 최근 실제로 실적을 발표한 경우만.
  for (const m of GLOBAL_MAPPING.filter((g) => g.exposureSymbols.includes(symbol))) {
    const peer = (d.usEarnings?.items || []).find((it) => it.symbol === m.globalSymbol);
    if (!peer) continue;
    const since = businessDaysBetween(new Date(peer.report_date), today);
    if (since == null || since > PEER_EARNINGS_RECENT_BUSINESS_DAYS) continue;
    const react = cumReaction(peer.reaction);
    const ok = peer.surprise_pct != null && peer.surprise_pct >= PEER_SURPRISE_MIN_PCT && (react == null || react > 0);
    checks.globalPeerEarnings = checks.globalPeerEarnings || ok;
    catalysts.push({ type: 'Global Peer Earnings', label: `${m.globalSymbol}(${m.relation}) ${peer.report_date} 실적 — EPS 서프라이즈 ${sgn(peer.surprise_pct)}${peer.surprise_pct}%, 주가 ${react != null ? `${sgn(react)}${react}%` : '미집계'}`, daysUntil: -since, filedDaysAgo: since, direction: ok ? 'positive' : 'neutral', source: 'US Earnings' });
  }

  const loaded = d.capitalIncreaseFree || d.treasuryStock || d.krEarnings || d.convertibleBond;
  if (!loaded) return { available: false, score: 0, availableWeight: 0, breakdown: [], catalysts: [] };
  // Catalyst를 찾아봤는데 없는 것은 "평가 불가"가 아니라 "없음"이다 → false.
  for (const r of CATALYST_TIMING_RULES) if (checks[r.id] == null) checks[r.id] = false;
  const result = scoreRules(CATALYST_TIMING_RULES, checks, CATALYST_WEIGHTS.timing);
  const newFilings = catalysts.filter((c) => c.filedDaysAgo != null && c.filedDaysAgo <= NEW_FILING_BUSINESS_DAYS);
  const upcoming = catalysts.filter((c) => within(c.daysUntil)).sort((a, b) => a.daysUntil - b.daysUntil);
  return { ...result, catalysts, newFilings, upcoming };
}

/** Corporate: 경제적 크기(비율)로만 점수화. 금액/주식수를 모르면 그 규칙은 평가 불가(분모 제외). */
export function evalCorporate(symbol, d, quote) {
  const checks = { largeFreeDistribution: null, dilutionSmall: null };
  const metrics = [], risks = [], informational = [];

  for (const it of find(d.capitalIncreaseFree, symbol)) {
    const ratio = parseFloat(it.ratio_per_share);
    if (Number.isFinite(ratio)) {
      checks.largeFreeDistribution = ratio >= EVENT_THRESHOLDS.largeFreeRatio;
      metrics.push(`무상증자 배정비율 ${(ratio * 100).toFixed(0)}% (기존 1주당 ${ratio}주)`);
    }
  }
  for (const it of find(d.capitalIncreasePaid, symbol)) {
    const newShares = Number(String(it.new_shares || '').replace(/,/g, ''));
    if (quote?.sharesOutstanding && Number.isFinite(newShares) && newShares > 0) {
      const ratio = newShares / quote.sharesOutstanding;
      checks.dilutionSmall = ratio < EVENT_THRESHOLDS.dilutionNotable;
      metrics.push(`유상증자 신주/기존주식 ${(ratio * 100).toFixed(1)}%`);
      if (ratio >= EVENT_THRESHOLDS.dilutionNotable) risks.push(`유상증자 희석 ${(ratio * 100).toFixed(1)}%`);
    } else {
      informational.push(`유상증자(${it.method || '방식 미상'}) — 신주수/상장주식수 미확인으로 희석비율 계산 불가`);
      risks.push('유상증자 공시 (희석 규모 미확인)');
    }
  }
  for (const it of find(d.treasuryStock, symbol)) {
    informational.push(`자사주 ${it.type} — 수집 필드에 금액이 없어 시총 대비 비율 계산 불가, Corporate 점수 미반영`);
    if (it.type === '처분') risks.push('자사주 처분 (잠재 매도물량)');
  }
  for (const it of find(d.convertibleBond, symbol)) {
    informational.push('CB 발행 — 발행금액 미수집으로 잠재 희석률 계산 불가, 점수 미반영');
    risks.push(`CB 잠재 물량 (전환가 ${it.conversion_price ?? '-'}원, 전환개시 ${it.conversion_start ?? '-'})`);
  }

  const result = scoreRules(CORPORATE_RULES, checks, CATALYST_WEIGHTS.corporate);
  return { ...result, metrics, risks, informational };
}
