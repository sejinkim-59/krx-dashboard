import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchAllEtfList, pickDomesticThemeEtfs, fetchEtfHoldings } from './lib/naver-etf.mjs';
import { writeJson, sleep, DATA_DIR } from './lib/util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = path.join(DATA_DIR, 'etf-holdings-snapshot.json');
const TOP_N = 25;
const WEIGHT_CHANGE_THRESHOLD = 1.5; // 퍼센트포인트 이상 변화만 "주목할 만한 변화"로 표시

const KEYWORDS = ['반도체', '2차전지', '바이오', '헬스케어', '은행', '방산', '게임', '인터넷', '미디어', '로봇', '원자력', '조선', '철강', '자동차', '화학', '엔터'];
const EXCLUDE = ['미국', '글로벌', '차이나', '나스닥', 'S&P', '유럽', '일본', '인도', '베트남', '달러'];

async function loadPrevSnapshot() {
  try {
    return JSON.parse(await readFile(SNAPSHOT_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

function diffHoldings(prevHoldings, currHoldings) {
  const prevMap = new Map((prevHoldings || []).map((h) => [h.name, h.weight]));
  const currMap = new Map(currHoldings.map((h) => [h.name, h.weight]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [name, weight] of currMap) {
    if (!prevMap.has(name)) added.push({ name, weight });
  }
  for (const [name, weight] of prevMap) {
    if (!currMap.has(name)) removed.push({ name, weight });
  }
  for (const [name, weight] of currMap) {
    if (prevMap.has(name)) {
      const delta = weight - prevMap.get(name);
      if (Math.abs(delta) >= WEIGHT_CHANGE_THRESHOLD) changed.push({ name, prev_weight: prevMap.get(name), curr_weight: weight, delta: +delta.toFixed(2) });
    }
  }
  changed.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return { added, removed, changed };
}

async function main() {
  console.log('[etf-rebalance] ETF 목록 수집 중...');
  const allEtfs = await fetchAllEtfList();
  const targets = pickDomesticThemeEtfs(allEtfs, { keywords: KEYWORDS, exclude: EXCLUDE, topN: TOP_N });
  console.log(`[etf-rebalance] 대상 ETF ${targets.length}개 선정`);

  const prevSnapshot = await loadPrevSnapshot();
  const prevByCode = new Map((prevSnapshot?.etfs || []).map((e) => [e.code, e]));

  const currentSnapshot = { generated_at: new Date().toISOString(), etfs: [] };
  const diffs = [];

  for (const etf of targets) {
    try {
      const { trdDt, holdings } = await fetchEtfHoldings(etf.itemcode);
      currentSnapshot.etfs.push({ code: etf.itemcode, name: etf.itemname, trd_dt: trdDt, holdings });
      const prev = prevByCode.get(etf.itemcode);
      if (prev) {
        const d = diffHoldings(prev.holdings, holdings);
        if (d.added.length || d.removed.length || d.changed.length) {
          diffs.push({ code: etf.itemcode, name: etf.itemname, trd_dt: trdDt, prev_trd_dt: prev.trd_dt, ...d });
        }
      }
    } catch (e) {
      console.warn(`[etf-rebalance] ${etf.itemname} 실패:`, e.message);
    }
    await sleep(250);
  }

  await writeJson('etf-holdings-snapshot.json', currentSnapshot);
  await writeJson('etf-rebalance-detect.json', {
    updated_at: new Date().toISOString(),
    note: `국내 섹터·테마 ETF 상위 ${TOP_N}종목의 전일 스냅샷 대비 구성종목 변화 감지. 신규 편입·편출 종목과 비중 ${WEIGHT_CHANGE_THRESHOLD}%p 이상 변동 종목을 표시합니다. (첫 실행 시에는 비교 대상이 없어 결과가 비어있습니다)`,
    universe_size: targets.length,
    has_baseline: !!prevSnapshot,
    changed_etf_count: diffs.length,
    items: diffs,
  });

  console.log(`[etf-rebalance] 완료: ${diffs.length}개 ETF에서 변화 감지 (베이스라인 ${prevSnapshot ? '있음' : '없음(최초 실행)'})`);
}

main().catch((e) => {
  console.error('[etf-rebalance] 실패:', e);
  process.exit(1);
});
