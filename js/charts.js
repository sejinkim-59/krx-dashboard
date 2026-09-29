// Chart.js 전역 기본값 — dataviz 스킬의 검증된 라이트 팔레트를 그대로 사용.
const VIZ = {
  up: '#e34948', // 상승(빨강, 한국 관행)
  down: '#2a78d6', // 하락(파랑)
  flat: '#898781',
  gridline: '#e1e0d9',
  baseline: '#c3c2b7',
  textSecondary: '#52514e',
  muted: '#898781',
  surface: '#fcfcfb',
  seqBlue: ['#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#256abf', '#184f95'], // ordinal 램프: 라이트 표면에서 2:1 이상 유지되는 250~600 구간
};

if (window.Chart) {
  Chart.defaults.color = VIZ.textSecondary;
  Chart.defaults.font.family = "'Pretendard Variable', Pretendard, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
  Chart.defaults.font.size = 11;
  Chart.defaults.borderColor = VIZ.gridline;
  Chart.defaults.plugins.legend.labels.boxWidth = 10;
  Chart.defaults.plugins.legend.labels.boxHeight = 10;
  Chart.defaults.plugins.tooltip.backgroundColor = '#1a1a19';
  Chart.defaults.plugins.tooltip.titleColor = '#ffffff';
  Chart.defaults.plugins.tooltip.bodyColor = '#e6e5e0';
  Chart.defaults.plugins.tooltip.borderColor = 'rgba(255,255,255,0.08)';
  Chart.defaults.plugins.tooltip.borderWidth = 1;
  Chart.defaults.plugins.tooltip.padding = 8;
}

function destroyIfExists(canvas) {
  const existing = Chart.getChart(canvas);
  if (existing) existing.destroy();
}

/**
 * 시간순 정렬된 여러 계열(예: 분기별)을 시퀀셜 블루 램프로 표현하는 라인차트.
 * series: [{ label, points: {x:string, y:number}[] }]  (오래된 것 -> 최신 순)
 */
function makeOrdinalLineChart(canvas, series, { unit = '%' } = {}) {
  destroyIfExists(canvas);
  const ramp = VIZ.seqBlue;
  const n = series.length;
  const labels = series[0]?.points.map((p) => p.x) || [];
  return new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: series.map((s, i) => ({
        label: s.label,
        data: s.points.map((p) => p.y),
        borderColor: ramp[Math.min(ramp.length - 1, Math.round((i / Math.max(1, n - 1)) * (ramp.length - 1)))],
        backgroundColor: 'transparent',
        borderWidth: i === n - 1 ? 2.5 : 2,
        pointRadius: 2,
        pointHoverRadius: 4,
        tension: 0.15,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { usePointStyle: true, pointStyle: 'line' } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y > 0 ? '+' : ''}${ctx.parsed.y}${unit}` } },
      },
      scales: {
        x: { grid: { display: false }, border: { color: VIZ.baseline } },
        y: {
          grid: { color: VIZ.gridline },
          border: { color: VIZ.baseline },
          ticks: { callback: (v) => `${v}${unit}` },
        },
      },
    },
  });
}

/**
 * 그리드 카드 타일에 넣는 초소형 인라인 스파크라인 (Chart.js 없이 순수 SVG).
 */
function buildSparklineSvg(values, { width = 72, height = 24 } = {}) {
  const clean = values.filter((v) => typeof v === 'number' && !Number.isNaN(v));
  if (clean.length < 2) return '';
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const range = max - min || 1;
  const stepX = width / (clean.length - 1);
  const pts = clean.map((v, i) => {
    const x = i * stepX;
    const y = height - ((v - min) / range) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const trendUp = clean[clean.length - 1] >= clean[0];
  const color = trendUp ? VIZ.up : VIZ.down;
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none">
    <polyline points="${pts.join(' ')}" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
  </svg>`;
}

/**
 * 레퍼런스 스타일의 커스텀 랭크바 리스트 (Chart.js 없이 순수 HTML/CSS).
 * colorMode: 'signed'(부호에 따라 빨강/파랑) | 'neutral'(단일 색, magnitude 전용)
 */
function renderRankBars(items, { labelKey, valueKey, fmt = (v) => v.toLocaleString(), colorMode = 'signed', maxItems = 15, presorted = false } = {}) {
  const sorted = presorted ? items.slice(0, maxItems) : [...items].sort((a, b) => Math.abs(b[valueKey]) - Math.abs(a[valueKey])).slice(0, maxItems);
  if (!sorted.length) return '';
  const maxAbs = Math.max(...sorted.map((it) => Math.abs(it[valueKey])), 1e-9);
  const rows = sorted.map((it) => {
    const v = it[valueKey];
    const pct = Math.max(2, (Math.abs(v) / maxAbs) * 100);
    const cls = colorMode === 'signed' ? (v >= 0 ? 'up' : 'down') : 'neutral';
    return `<div class="rankbar-row">
      <span class="rankbar-label" title="${it[labelKey]}">${it[labelKey]}</span>
      <div class="rankbar-track"><div class="rankbar-fill ${cls}" style="width:${pct}%"></div></div>
      <span class="rankbar-value ${cls}">${fmt(v)}</span>
    </div>`;
  }).join('');
  return `<div class="rankbar-list">${rows}</div>`;
}

/** hex 색을 factor(0~1)만큼 어둡게 섞은 rgb 문자열 반환 (패널 배너 그라데이션용). */
function shade(hex, factor) {
  const h = hex.replace('#', '');
  const r = Math.round(parseInt(h.slice(0, 2), 16) * (1 - factor));
  const g = Math.round(parseInt(h.slice(2, 4), 16) * (1 - factor));
  const b = Math.round(parseInt(h.slice(4, 6), 16) * (1 - factor));
  return `rgb(${r}, ${g}, ${b})`;
}
