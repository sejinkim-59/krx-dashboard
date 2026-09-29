// Selection Engine v0.5 — 백테스트로 검증된 규칙(strategy-s7)으로 하루 5종목을 고르고, 섹션 18 형식으로 설명을 붙인다.
// 순위 = 미반영·변화 후 수익률·변동성·유동성 (lib/strategy-s7). "변화의 크기"와 수급 확인은 순위에 쓰지 않는다
// — 2024-04~2026-09 전종목 백테스트에서 둘 다 선행수익 예측력이 음(-) 또는 0이었기 때문.
// WHAT CHANGED/수급/공시는 설명(Context)으로 계속 보여준다.

import { buildAdjustedBars, featureRowsAt } from './market-features.mjs';
import { pickS7, scoreS7 } from './strategy-s7.mjs';
import { evalCatalystTiming } from './catalyst.mjs';
import { whyNotPricedText } from './context.mjs';
import { fmtWon, sgn } from './scoring-utils.mjs';

export const V05_CONFIG = {
  excludeTopCap: Number(process.env.V05_EXCLUDE_TOP_CAP || 30), // 30: 초과수익 최대 / 60·100: 더 "발견"다운 대신 초과수익 약 절반~60%
  repeatBlockDays: 5,
  picks: 5,
};

// 사전등록 holdout 포함 백테스트 요약 — 화면/설명에 그대로 인용 (과장 금지: 평균 초과수익과 승률만)
export const V05_BACKTEST = {
  period: '2024-04-15 ~ 2026-09-18 (전종목, T+1 시가 진입)',
  holdout: '2024-04 ~ 2025-06 (사전등록, 규칙 고정 후 1회 평가)',
  excessVsPool: { d5: '+0.6%p', d10: '+1.5%p', d20: '+3.0%p' },
  winRate: { d5: '약 52%', d20: '약 57%' },
  caveat: '시장 전체가 하락하면 선정 종목도 대부분 하락한다. 초과수익은 평균이며 개별 종목 결과는 크게 다르다.',
};

const DIRECTIONAL = { 9000: '외국인', 7050: '기관합계', 6000: '연기금 등' };
const won = (n) => (n == null ? '-' : `${Math.round(n).toLocaleString()}원`);

function flowEventsFor(symbol, investorFlow) {
  const out = [];
  for (const [code, inv] of Object.entries(investorFlow?.investors || {})) {
    const f = (inv.flips || []).find((x) => x.symbol === symbol);
    if (f) out.push({ investor: inv.label, directional: !!DIRECTIONAL[code], toBuy: f.recent_net > 0, swing: f.swing });
  }
  return out;
}

function alertFor(name, marketAlerts) {
  const lv = { invstriskisu_sub: 'risk', invstwarnisu_sub: 'warn', invstcautnisu_sub: 'caution' };
  for (const [key, cat] of Object.entries(marketAlerts?.categories || {})) {
    const hit = (cat.items || []).find((it) => it.corp_name === name);
    if (hit) return { level: lv[key] || 'caution', text: `${cat.label} 지정 (${hit.designated_date})` };
  }
  return null;
}

function changeLines(r, flows, catalyst) {
  const lines = [];
  for (const e of r.noveltyEvents || []) {
    const when = `${e.changeDate}, ${e.daysSinceChange}거래일 전`;
    if (e.id === 'ma20CrossAboveMa60') lines.push(`MA20이 MA60을 상향돌파 (${when})`);
    else if (e.id === 'priceCrossAboveMa20') lines.push(`종가가 MA20 위로 회복 (${when})`);
    else if (e.id === 'volumeSpike') lines.push(`거래량 20일 평균 대비 급증 (${when})`);
  }
  for (const f of flows.filter((x) => x.directional)) lines.push(`${f.investor} ${f.toBuy ? '순매도→순매수' : '순매수→순매도'} 전환 (최근 3거래일 vs 직전 5거래일, 변화폭 ${fmtWon(f.swing)})`);
  for (const c of catalyst.newFilings || []) lines.push(`새 공시: ${c.label} (${c.filedDaysAgo}거래일 전)`);
  return lines;
}

export function runSelectionV05(marketDays, d, { recentPicks = new Map(), today = new Date(), config = V05_CONFIG } = {}) {
  const ctx = buildAdjustedBars(marketDays);
  const t = ctx.cal.length - 1;
  const asOf = ctx.cal[t];
  const all = featureRowsAt(t, ctx);
  for (const r of all) r.isLargeCap = r.capRank <= config.excludeTopCap;

  // 안전 필터: 투자위험 지정 종목 제외 (경고/주의는 WATCH 표시만)
  const blocked = new Set([...recentPicks].filter(([, n]) => n < config.repeatBlockDays).map(([s]) => s));
  const rows = all.filter((r) => !blocked.has(r.symbol) && alertFor(r.name, d.marketAlerts)?.level !== 'risk');
  const picks = pickS7(rows, config.picks);
  const scored = scoreS7(rows).filter((r) => r.pricedIn !== 'likely_priced_in' && r.pricedIn !== 'partially_priced_in').sort((a, b) => b.s7 - a.s7);
  const pct = (r) => Math.round((1 - scored.indexOf(r) / Math.max(1, scored.length)) * 1000) / 10;

  const toFinal = (r, i) => {
    const flows = flowEventsFor(r.symbol, d.investorFlow);
    const catalyst = evalCatalystTiming(r.symbol, r.name, d, today);
    const whatChanged = changeLines(r, flows, catalyst);
    const alert = alertFor(r.name, d.marketAlerts);
    const short = (d.shortSelling?.items || []).find((x) => x.symbol === r.symbol);
    const riskList = [
      alert ? alert.text : null,
      short && short.short_ratio_pct >= 30 ? `공매도 비중 ${short.short_ratio_pct}%` : null,
      ...(catalyst.catalysts || []).filter((c) => c.direction === 'supply' || c.direction === 'negative').map((c) => c.label),
      ...flows.filter((f) => f.directional && !f.toBuy).map((f) => `${f.investor} 순매도 전환 (백테스트상 방향성 예측력은 약함)`),
    ].filter(Boolean);
    const whyNotPriced = whyNotPricedText({ available: true, verdict: r.pricedIn, lines: r.pricedInLines || [] });
    const parts = r.s7Parts;
    const confirmation = [
      `미반영 판정 ${r.pricedIn === 'not_yet_priced' ? '아직 제한적 반응' : '판단 보류(과열 아님)'}`,
      `변동성 ATR/종가 ${r.atrPct?.toFixed(1)}% (후보 대비 ${parts.volatility >= 0 ? '낮음' : '높음'})`,
      `20일 평균 거래대금 ${fmtWon(r.tradVal20).replace(/^\+/, '')}`,
      `시총 ${r.capRank}위 (상위 ${config.excludeTopCap} 제외 기준)`,
    ].join(' + ');
    const invalidation = [
      r.ma20 ? `종가가 MA20(${won(r.ma20)}) 아래로 이탈` : null,
      '선정 후 단기 급등(+10% 이상)으로 "반영 완료" 판정 시 교체 대상',
      alert ? null : '투자경고·위험 지정 시 즉시 제외',
    ].filter(Boolean).join(' / ');
    const strategy = 'Not-yet-priced · Low-vol';
    return {
      symbol: r.symbol, company: r.name, bucket: 'DISCOVERY', bucketLabel: 'Discovery', strategy,
      score: pct(r), alpha: Math.round(r.s7 * 100) / 100, alphaParts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v * 100) / 100])),
      noveltyScore: null, catalystScore: null, technicalScore: null, flowScore: null, revisionScore: null, relativeStrengthScore: null,
      dataCoverage: 100, confidence: 'Normal',
      whatChanged, whyNow: `오늘(${asOf} 종가 기준) 후보 ${scored.length}종목 중 ${i + 1}위 — 미반영·저변동·유동성 복합 점수 상위`,
      whyNotPriced, confirmation, invalidation,
      risks: riskList.length ? riskList.join(' · ') : '특이 리스크 없음',
      catalysts: (catalyst.catalysts || []).map((c) => c.label),
      sources: ['KRX 전종목 일별 시세', ...(flows.length ? ['KRX 투자자별 매매동향'] : []), ...((catalyst.catalysts || []).length ? ['DART'] : [])],
      pricedIn: { verdict: r.pricedIn, facts: r.pricedInLines || [] },
      marketCapRank: r.capRank,
      metrics: { close: r.close, r5: r.r5, r20: r.r20, atrPct: r.atrPct, dHigh52: r.dHigh52, tradVal20: r.tradVal20 },
      // --- 기존 UI 호환 ---
      setup: `Discovery · ${strategy}`,
      reason: whatChanged[0] || `새 변화 신호는 없지만 가격 반응이 제한적이고 변동성이 낮은 종목 (${r.pricedIn === 'not_yet_priced' ? '미반영' : '반영 판단 보류'})`,
      evidence: [
        `WHY NOW: 후보 ${scored.length}종목 중 ${i + 1}위`,
        whyNotPriced ? `WHY NOT PRICED: ${whyNotPriced}` : null,
        ...whatChanged.slice(1).map((l) => `CHANGED: ${l}`),
        `CONFIRMS: ${confirmation}`,
        `근거 규칙 백테스트: 5일 초과수익 ${V05_BACKTEST.excessVsPool.d5}, 20일 ${V05_BACKTEST.excessVsPool.d20} (후보풀 평균 대비, ${V05_BACKTEST.period})`,
      ].filter(Boolean),
      counterEvidence: [...riskList, V05_BACKTEST.caveat],
      watch: whatChanged.length ? '변화 신호 이후 가격이 추가로 반응하는지 (+10% 이상이면 반영 완료)' : 'MA20 위 유지 여부와 거래대금 유지',
      riskDecision: riskList.length ? 'WATCH' : 'PASS',
      scoreBreakdown: Object.entries(parts).map(([k, v]) => `${k} ${v >= 0 ? '+' : ''}${v.toFixed(2)}`),
      priority: pct(r),
    };
  };

  const finalPicks = picks.map(toFinal);
  return {
    asOf,
    engineVersion: 'v0.5',
    config,
    backtest: V05_BACKTEST,
    universe: { totalCount: Object.keys(marketDays[t].data).length, liquidCount: all.length, eligibleCount: scored.length, blockedRepeat: blocked.size },
    finalPicks,
    topCandidates: scored.slice(0, 20).map((r) => ({
      symbol: r.symbol, name: r.name, score: pct(r), alpha: Math.round(r.s7 * 100) / 100, marketCapRank: r.capRank, pricedInVerdict: r.pricedIn,
      bucket: picks.includes(r) ? 'DISCOVERY' : null,
      topEvidence: changeLines(r, flowEventsFor(r.symbol, d.investorFlow), { newFilings: [] })[0] || `미반영(${r.pricedIn}) · ATR ${r.atrPct?.toFixed(1)}% · 20일 ${sgn(r.r20)}${r.r20?.toFixed(1)}%`,
      signalTypes: [picks.includes(r) ? 'Discovery' : 'v0.5 후보', r.pricedIn === 'not_yet_priced' ? '미반영' : '판단보류'],
      scoreBreakdown: Object.entries(r.s7Parts).map(([k, v]) => `${k} ${v >= 0 ? '+' : ''}${v.toFixed(2)}`),
      risk: { decision: 'PASS', reason: '-' },
    })),
  };
}
