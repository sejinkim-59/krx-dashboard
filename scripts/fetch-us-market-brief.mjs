import { fetchDailyHistory } from './lib/yahoo.mjs';
import { writeJson, sleep } from './lib/util.mjs';

const INSTRUMENTS = [
  { symbol: '^GSPC', label: 'S&P 500' },
  { symbol: '^IXIC', label: '나스닥종합' },
  { symbol: '^DJI', label: '다우존스' },
  { symbol: '^VIX', label: 'VIX(변동성지수)' },
  { symbol: '^TNX', label: '美 10년물 국채금리' },
  { symbol: 'KRW=X', label: '원/달러 환율' },
  { symbol: 'CL=F', label: 'WTI 원유' },
  { symbol: 'GC=F', label: '금 선물' },
];

function pctChange(closes) {
  if (closes.length < 2) return null;
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  if (!prev) return null;
  return +(((last - prev) / prev) * 100).toFixed(2);
}

function buildSummaryText(rows) {
  const sp = rows.find((r) => r.symbol === '^GSPC');
  const nasdaq = rows.find((r) => r.symbol === '^IXIC');
  const dow = rows.find((r) => r.symbol === '^DJI');
  const vix = rows.find((r) => r.symbol === '^VIX');
  const dir = (v) => (v == null ? '보합' : v > 0 ? `${v}% 상승` : `${v}% 하락`);
  const parts = [];
  if (sp) parts.push(`S&P500 ${dir(sp.change_pct)}`);
  if (nasdaq) parts.push(`나스닥 ${dir(nasdaq.change_pct)}`);
  if (dow) parts.push(`다우 ${dir(dow.change_pct)}`);
  let text = `전일 미국 증시는 ${parts.join(', ')}으로 마감했습니다.`;
  if (vix) {
    text += vix.change_pct > 5 ? ' VIX가 큰 폭으로 올라 시장 변동성이 확대됐습니다.' : vix.change_pct < -5 ? ' VIX는 하락하며 위험선호 심리가 회복됐습니다.' : '';
  }
  return text;
}

async function main() {
  const rows = [];
  for (const { symbol, label } of INSTRUMENTS) {
    try {
      const hist = await fetchDailyHistory(symbol, '5d');
      const closes = hist.close.filter((c) => c != null);
      rows.push({
        symbol,
        label,
        last: closes[closes.length - 1] ?? null,
        change_pct: pctChange(closes),
      });
    } catch (e) {
      console.warn(`[market-brief] ${symbol} 실패:`, e.message);
      rows.push({ symbol, label, last: null, change_pct: null, error: String(e.message || e) });
    }
    await sleep(200);
  }

  await writeJson('us-market-brief.json', {
    updated_at: new Date().toISOString(),
    summary: buildSummaryText(rows),
    instruments: rows,
  });

  console.log('[market-brief] 완료');
}

main().catch((e) => {
  console.error('[market-brief] 실패:', e);
  process.exit(1);
});
