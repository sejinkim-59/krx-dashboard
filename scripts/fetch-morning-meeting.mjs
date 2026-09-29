import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeJson, todayKst, DATA_DIR } from './lib/util.mjs';
import { classifyMarketRegime } from './lib/ai-desk.mjs';
import { runSelectionEngine, buildUniverse } from './lib/selection-engine.mjs';
import { preScreen, enrich, allocateEnrichment, fetchTrackingOhlcv } from './lib/discovery-enrich.mjs';
import { STRATEGY_CONFIG, DISCOVERY_CONFIG } from './lib/selection-config.mjs';

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

/** Backtest Log(Learning Desk): 오늘 Final Pick을 기록하고, 지난 선정 건의 D+1/D+5/D+20 성과를 KIS OHLCV로 채운다. */
async function updateLearningLog(meeting, kisQuotes, kisOhlcv) {
  const log = (await readJsonSafe('learning-log.json')) || { entries: [] };

  // 30분 배치라 하루에도 선정이 바뀐다. 오늘 기록은 "오늘의 최신 발표본"으로 교체하고, 지난 날짜는 고정한다.
  // (하루 중 한 번이라도 떴던 종목이 전부 누적되면 백테스트 표본이 오염된다)
  log.entries = log.entries.filter((e) => e.date !== meeting.date);
  for (const sel of meeting.selections) {
    const quote = kisQuotes?.items?.find((q) => q.symbol === sel.symbol);
    log.entries.push({
      engineVersion: meeting.engineVersion || null,
      date: meeting.date,
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
      priceAtSelection: quote ? quote.price : null,
      hasPriceData: !!(quote && kisOhlcv?.symbols?.[sel.symbol]),
      d1: null,
      d5: null,
      d20: null,
    });
  }

  for (const entry of log.entries) {
    if (!entry.hasPriceData || entry.priceAtSelection == null) continue;
    const bars = kisOhlcv?.symbols?.[entry.symbol];
    if (!bars) continue;
    const startIdx = bars.findIndex((b) => b.time === dashDate(entry.date));
    if (startIdx === -1) continue;
    const setOutcome = (key, offset) => {
      if (entry[key] != null) return;
      const bar = bars[startIdx + offset];
      if (!bar) return;
      entry[key] = Number((((bar.close - entry.priceAtSelection) / entry.priceAtSelection) * 100).toFixed(2));
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

  const dateStr = todayKst();
  const regime = classifyMarketRegime(d.usMarketBrief);
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

  const log = await updateLearningLog(meeting, d.kisQuotes, d.kisOhlcv);
  const learningSummary = summarizeLearning(log);
  await writeJson('learning-summary.json', { updated_at: new Date().toISOString(), ...learningSummary });

  const slotLine = meeting.dailyOutput.map((s) => `${s.label} ${s.picks.length}/${s.requested}`).join(', ');
  console.log(`[morning-meeting] 완료: Universe ${meeting.screening.universeCount} (가격 확보 ${meeting.screening.technicalCoverageCount}) / Signal ${meeting.screening.signalCount} / Gate 통과 ${meeting.screening.passedRiskCount} / ${slotLine}`);
}

main().catch((e) => {
  console.error('[morning-meeting] 실패:', e.message);
  process.exit(1);
});
