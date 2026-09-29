import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJson, todayKst, DATA_DIR } from './lib/util.mjs';
import { buildMorningMeeting } from './lib/ai-desk.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function readJsonSafe(filename) {
  try {
    const text = await readFile(path.join(DATA_DIR, filename), 'utf-8');
    return JSON.parse(text);
  } catch {
    return null; // 아직 수집되지 않았거나 이번 실행에서 실패한 소스 — 해당 Signal만 건너뛴다
  }
}

function dashDate(yyyymmdd) {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

/** Learning Desk 로그: 오늘 선정 종목을 기록하고, 이미 지난 선정 건의 D+1/D+5/D+20 성과를 KIS OHLCV로 채운다. */
async function updateLearningLog(meeting, kisQuotes, kisOhlcv) {
  const log = (await readJsonSafe('learning-log.json')) || { entries: [] };

  for (const sel of meeting.selections) {
    const exists = log.entries.some((e) => e.date === meeting.date && e.symbol === sel.symbol);
    if (exists) continue;
    const quote = kisQuotes?.items?.find((q) => q.symbol === sel.symbol);
    log.entries.push({
      date: meeting.date,
      symbol: sel.symbol,
      name: sel.company,
      setup: sel.setup,
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
    if (startIdx === -1) continue; // 아직 100일 창에 없거나 선정일 데이터가 없음
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
  };

  const missing = Object.entries(d).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) console.warn(`[morning-meeting] 일부 소스 누락(해당 Signal 생략): ${missing.join(', ')}`);

  const meeting = buildMorningMeeting(d, todayKst());
  await writeJson('morning-meeting.json', meeting);

  const log = await updateLearningLog(meeting, d.kisQuotes, d.kisOhlcv);
  const learningSummary = summarizeLearning(log);
  await writeJson('learning-summary.json', { updated_at: new Date().toISOString(), ...learningSummary });

  console.log(`[morning-meeting] 완료: 유니버스 ${meeting.screening.universeCount} / 시그널 ${meeting.screening.signalCount} / 선정 ${meeting.selections.length} / 제외 ${meeting.rejectedCandidates.length}`);
}

main().catch((e) => {
  console.error('[morning-meeting] 실패:', e.message);
  process.exit(1);
});
