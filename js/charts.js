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
  Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Pretendard, Roboto, sans-serif";
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
 * 값의 부호(+/-)에 따라 빨강/파랑으로 칠하는 가로 막대 (베이시스, 신고가 등락 등 polarity 데이터).
 */
function makeDivergingHBar(canvas, items, { labelKey, valueKey, unit = '%', maxItems = 15, presorted = false, fmt } = {}) {
  destroyIfExists(canvas);
  const sorted = presorted ? items.slice(0, maxItems) : [...items].sort((a, b) => b[valueKey] - a[valueKey]).slice(0, maxItems);
  const format = fmt || ((v) => `${v > 0 ? '+' : ''}${v}${unit}`);
  return new Chart(canvas, {
    type: 'bar',
    data: {
      labels: sorted.map((it) => it[labelKey]),
      datasets: [{
        data: sorted.map((it) => it[valueKey]),
        backgroundColor: sorted.map((it) => (it[valueKey] >= 0 ? VIZ.up : VIZ.down)),
        borderRadius: 4,
        maxBarThickness: 18,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => format(ctx.parsed.x) } },
      },
      scales: {
        x: { grid: { color: VIZ.gridline }, ticks: { callback: format }, border: { color: VIZ.baseline } },
        y: { grid: { display: false }, border: { color: VIZ.baseline } },
      },
    },
  });
}

/**
 * 단일 계열 크기(magnitude) 비교용 가로 막대 — 시퀀셜 블루 한 가지 색.
 */
function makeMagnitudeHBar(canvas, items, { labelKey, valueKey, maxItems = 15, fmt = (v) => v.toLocaleString() } = {}) {
  destroyIfExists(canvas);
  const sorted = [...items].sort((a, b) => b[valueKey] - a[valueKey]).slice(0, maxItems);
  return new Chart(canvas, {
    type: 'bar',
    data: {
      labels: sorted.map((it) => it[labelKey]),
      datasets: [{
        data: sorted.map((it) => it[valueKey]),
        backgroundColor: VIZ.down,
        borderRadius: 4,
        maxBarThickness: 18,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => fmt(ctx.parsed.x) } },
      },
      scales: {
        x: { grid: { color: VIZ.gridline }, ticks: { callback: fmt }, border: { color: VIZ.baseline } },
        y: { grid: { display: false }, border: { color: VIZ.baseline } },
      },
    },
  });
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
