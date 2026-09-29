import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeJson, todayKst, DATA_DIR } from './lib/util.mjs';
import { classifyMarketRegime } from './lib/ai-desk.mjs';
import { runSelectionEngine, buildUniverse } from './lib/selection-engine.mjs';
import { preScreen, enrich, allocateEnrichment, fetchTrackingOhlcv } from './lib/discovery-enrich.mjs';
import { STRATEGY_CONFIG, DISCOVERY_CONFIG } from './lib/selection-config.mjs';
import { runSelectionV05 } from './lib/selection-v05.mjs';
import { buildAdjustedBars } from './lib/market-features.mjs';
import { loadMarketDays } from './fetch-market-daily.mjs';

async function readJsonSafe(filename) {
  try {
    const text = await readFile(path.join(DATA_DIR, filename), 'utf-8');
    return JSON.parse(text);
  } catch {
    return null; // 아직 수집되지 않았거나 이번 실행에서 실패한 소스 — 해당 Factor만 MISSING_DATA 처리
  }
}

function dashDate(yyyymmdd) {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

/**
 * Backtest Log(Learning Desk): 오늘 Final Pick을 기록하고, 지난 선정 건의 D+1/D+5/D+20 성과를 채운다.
 * barsOf(symbol) → [{time:'YYYY-MM-DD', close}] (수정주가). 성과는 같은 시계열 안에서 신호일 종가 대비로 계산해
 * 중간에 액면분할이 있어도 왜곡되지 않게 한다.
 */
async function updateLearningLog(meeting, barsOf) {
  const log = (await readJsonSafe('learning-log.json')) || { entries: [] };

  // 30분 배치라 하루에도 선정이 바뀐다. 오늘 기록은 "오늘의 최신 발표본"으로 교체하고, 지난 날짜는 고정한다.
  // (하루 중 한 번이라도 떴던 종목이 전부 누적되면 백테스트 표본이 오염된다)
  log.entries = log.entries.filter((e) => e.date !== meeting.date);
  for (const sel of meeting.selections) {
    const bars = barsOf(sel.symbol);
    const signalDate = meeting.signalDate || meeting.date;
    const sigBar = bars?.find((b) => b.time === dashDate(signalDate));
    log.entries.push({
      engineVersion: meeting.engineVersion || null,
      date: meeting.date,
      signalDate,
      symbol: sel.symbol,
      name: sel.company,
      setup: sel.bucketLabel || sel.setup,
      bucket: sel.bucket || null,
      strategy: sel.strategy,
      score: sel.score,
      noveltyScore: sel.noveltyScore ?? null,
      pricedInVerdict: sel.pricedIn?.verdict ?? null,
      dataCoverage: sel.dataCoverage,
      marketRegime: meeting.marketRegime.state,
      priceAtSelection: sigBar ? sigBar.close : null,
      hasPriceData: !!sigBar,
      d1: null,
      d5: null,
      d20: null,
    });
  }

  for (const entry of log.entries) {
    const bars = barsOf(entry.symbol);
    if (!bars) continue;
    const startIdx = bars.findIndex((b) => b.time === dashDate(entry.signalDate || entry.date));
    if (startIdx === -1) continue;
    entry.hasPriceData = true;
    const base = bars[startIdx].close;
    const setOutcome = (key, offset) => {
      if (entry[key] != null) return;
      const bar = bars[startIdx + offset];
      if (!bar || !base) return;
      entry[key] = Number((((bar.close - base) / base) * 100).toFixed(2));
    };
    setOutcome('d1', 1);
    setOutcome('d5', 5);
    setOutcome('d20', 20);
  }

  await writeJson('learning-log.json', log);
  return log;
}

function summarizeLearning(log) {
  const bySetup = {};
  for (const e of log.entries) {
    if (e.d5 == null) continue;
    bySetup[e.setup] = bySetup[e.setup] || [];
    bySetup[e.setup].push(e.d5);
  }
  const stats = Object.entries(bySetup).map(([setup, arr]) => ({
    setup,
    count: arr.length,
    avgD5: Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2)),
  }));
  return { totalEntries: log.entries.length, resolvedD5: Object.values(bySetup).flat().length, bySetup: stats };
}

async function main() {
  const d = {
    kisQuotes: await readJsonSafe('kis-quotes.json'),
    kisOhlcv: await readJsonSafe('kis-ohlcv.json'),
    investorFlow: await readJsonSafe('investor-flow.json'),
    shortSelling: await readJsonSafe('short-selling.json'),
    marketAlerts: await readJsonSafe('market-alerts.json'),
    capitalIncreasePaid: await readJsonSafe('dart-capital-increase-paid.json'),
    capitalIncreaseFree: await readJsonSafe('dart-capital-increase-free.json'),
    convertibleBond: await readJsonSafe('dart-convertible-bond.json'),
    treasuryStock: await readJsonSafe('dart-treasury-stock.json'),
    insiderPlan: await readJsonSafe('dart-insider-plan.json'),
    krEarnings: await readJsonSafe('kr-earnings-reaction.json'),
    usMarketBrief: await readJsonSafe('us-market-brief.json'),
    usEarnings: await readJsonSafe('us-earnings-reaction.json'),
    etfRebalance: await readJsonSafe('etf-rebalance-detect.json'),
  };

  const missing = Object.entries(d).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) console.warn(`[morning-meeting] 일부 소스 누락(해당 Factor MISSING_DATA 처리): ${missing.join(', ')}`);

  const dateStr = todayKst();
  const regime = classifyMarketRegime(d.usMarketBrief);
  if ((process.env.ENGINE_PROFILE || 'v0.2') === 'v0.5') {
    await runV05Meeting(d, dateStr, regime);
    return;
  }

  // --- Discovery Enrichment: 관심종목 밖 후보를 pre-screen 후 상위 N개만 KIS 시세·일봉 추가 조회 ---
  const candidatesForEnrich = preScreen(buildUniverse(d), d);
  let discovery;
  if (process.env.DISCOVERY_USE_CACHE === '1') {
    discovery = (await readJsonSafe('kis-discovery.json')) || { quotes: [], ohlcv: {}, errors: ['cache 없음'] };
    console.log(`[morning-meeting] Discovery cache 사용: ${discovery.quotes.length}종목`);
  } else {
    const toFetch = allocateEnrichment(candidatesForEnrich);
    const evCount = toFetch.filter((c) => c.tags.includes('positive_event')).length;
    console.log(`[morning-meeting] Discovery pre-screen ${candidatesForEnrich.length}종목 → ${toFetch.length}개 KIS 조회 (이벤트 종목 ${evCount}개 포함)`);
    discovery = await enrich(toFetch);
    await writeJson('kis-discovery.json', { updated_at: new Date().toISOString(), note: 'Discovery 후보 추가 조회 (관심종목 외). 30분 배치 — 실시간 아님.', preScreenCount: candidatesForEnrich.length, ...discovery });
    console.log(`[morning-meeting] Discovery 조회 완료: 시세 ${discovery.quotes.length}, 일봉 ${Object.keys(discovery.ohlcv).length}, 오류 ${discovery.errors.length}`);
  }
  d.kisQuotes = { ...d.kisQuotes, items: [...(d.kisQuotes?.items || []), ...discovery.quotes] };
  d.kisOhlcv = { ...d.kisOhlcv, symbols: { ...(d.kisOhlcv?.symbols || {}), ...discovery.ohlcv } };

  // 과거 선정 종목(관심종목 밖)의 D+1/D+5/D+20 성과를 계속 계산하려면 그 종목의 일봉이 매일 필요하다.
  const priorLog = (await readJsonSafe('learning-log.json')) || { entries: [] };
  const pending = [...new Set(priorLog.entries.filter((e) => e.d20 == null).map((e) => e.symbol))].filter((s) => !d.kisOhlcv.symbols[s]);
  if (pending.length && process.env.DISCOVERY_USE_CACHE !== '1') {
    const tracked = await fetchTrackingOhlcv(pending);
    Object.assign(d.kisOhlcv.symbols, tracked.ohlcv);
    console.log(`[morning-meeting] 성과 추적용 일봉 추가 조회: ${Object.keys(tracked.ohlcv).length}/${pending.length}`);
  }

  regime.strategyPreference = STRATEGY_CONFIG[regime.state]?.preferred || [];
  regime.avoid = STRATEGY_CONFIG[regime.state]?.avoid || [];
  const engineResult = runSelectionEngine(d, dateStr, regime.state);

  const meeting = {
    date: dateStr,
    generated_at: engineResult.generated_at,
    engineVersion: engineResult.engineVersion,
    objective: engineResult.objective,
    methodologyNote: engineResult.methodologyNote,
    marketRegime: regime,
    screening: {
      universeCount: engineResult.universe.totalCount,
      technicalCoverageCount: engineResult.universe.technicalCoverageCount,
      discoveryPreScreenCount: candidatesForEnrich.length,
      discoveryEnrichedCount: discovery.quotes.length,
      signalCount: engineResult.universe.signalDetectedCount,
      passedRiskCount: engineResult.universe.eligibleCount,
      rejectedCount: engineResult.rejectedCandidates.length,
    },
    dailyOutput: engineResult.dailyOutput,
    selections: engineResult.finalPicks,
    rejectedCandidates: engineResult.rejectedCandidates,
    candidateQueue: engineResult.topCandidates,
  };

  await writeJson('morning-meeting.json', meeting);

  const log = await updateLearningLog(meeting, (s) => d.kisOhlcv?.symbols?.[s] || null);
  const learningSummary = summarizeLearning(log);
  await writeJson('learning-summary.json', { updated_at: new Date().toISOString(), ...learningSummary });

  const slotLine = meeting.dailyOutput.map((s) => `${s.label} ${s.picks.length}/${s.requested}`).join(', ');
  console.log(`[morning-meeting] 완료: Universe ${meeting.screening.universeCount} (가격 확보 ${meeting.screening.technicalCoverageCount}) / Signal ${meeting.screening.signalCount} / Gate 통과 ${meeting.screening.passedRiskCount} / ${slotLine}`);
}

/** v0.5: KRX 전종목 일별 시세(fetch-market-daily 캐시)로 백테스트 검증 규칙을 그대로 실행 */
async function runV05Meeting(d, dateStr, regime) {
  const days = await loadMarketDays();
  if (days.length < 70) throw new Error(`전종목 일별 시세가 ${days.length}일뿐입니다 — fetch-market-daily를 먼저 실행하세요`);
  const cal = days.map((x) => x.date);
  const prior = (await readJsonSafe('learning-log.json')) || { entries: [] };
  const recentPicks = new Map();
  for (const e of prior.entries) {
    if (e.date >= dateStr) continue;
    const i = cal.findLastIndex((x) => x <= (e.signalDate || e.date));
    if (i === -1) continue;
    const ago = cal.length - 1 - i;
    recentPicks.set(e.symbol, Math.min(recentPicks.get(e.symbol) ?? 99, ago));
  }
  const r = runSelectionV05(days, d, { recentPicks });
  regime.strategyPreference = ['NOT_YET_PRICED', 'LOW_VOL'];
  regime.avoid = [];

  const meeting = {
    date: dateStr,
    signalDate: r.asOf,
    generated_at: new Date().toISOString(),
    engineVersion: r.engineVersion,
    objective: '가격이 아직 반응하지 않았고 변동성이 낮은 종목 — 2024-04~2026-09 전종목 백테스트(사전등록 holdout 포함)로 검증된 규칙',
    methodologyNote: `${r.asOf} 종가 기준. 시총 상위 ${r.config.excludeTopCap} 제외, 20일 평균 거래대금 50억 이상, 최근 ${r.config.repeatBlockDays}거래일 내 선정 종목 제외. 백테스트: ${r.backtest.period}, 후보풀 대비 평균 초과 5일 ${r.backtest.excessVsPool.d5}·20일 ${r.backtest.excessVsPool.d20}, 승률 5일 ${r.backtest.winRate.d5}. ${r.backtest.caveat}`,
    marketRegime: regime,
    screening: {
      universeCount: r.universe.totalCount,
      technicalCoverageCount: r.universe.liquidCount,
      signalCount: r.universe.eligibleCount,
      passedRiskCount: r.universe.eligibleCount,
      rejectedCount: 0,
    },
    dailyOutput: [{ bucket: 'DISCOVERY', label: 'Discovery', requested: r.config.picks, qualifiedCount: r.universe.eligibleCount, picks: r.finalPicks, emptyReason: null }],
    selections: r.finalPicks,
    rejectedCandidates: [],
    candidateQueue: r.topCandidates,
  };
  await writeJson('morning-meeting.json', meeting);

  const { barsBy } = buildAdjustedBars(days);
  const barsOf = (s) => {
    const b = barsBy.get(s);
    return b ? b.filter(Boolean).map((x) => ({ time: dashDate(x.time), close: x.close })) : null;
  };
  const log = await updateLearningLog(meeting, barsOf);
  await writeJson('learning-summary.json', { updated_at: new Date().toISOString(), ...summarizeLearning(log) });
  console.log(`[morning-meeting] v0.5 완료 (${r.asOf} 기준): 전종목 ${r.universe.totalCount} → 유동성 ${r.universe.liquidCount} → 후보 ${r.universe.eligibleCount} → ${r.finalPicks.map((p) => p.company).join(', ')}`);
}

main().catch((e) => {
  console.error('[morning-meeting] 실패:', e.message);
  process.exit(1);
});
