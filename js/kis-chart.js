// 의존성 없는 캔들스틱 + 거래량 차트 (SVG). Chart.js candlestick 플러그인/외부 라이브러리를 쓰지 않고
// 이 프로젝트의 기존 rank-bar/sparkline과 같은 방식으로 직접 그린다.
// 가격 정보 우선, gridline/axis 최소화, gradient 없음.

function renderCandlestickChart(container, bars) {
  if (!bars || !bars.length) {
    container.innerHTML = '<p class="hero-empty">차트 데이터가 없습니다.</p>';
    return;
  }
  const width = Math.max(320, container.clientWidth || 760);
  const height = 320;
  const volH = 56;
  const pad = { top: 10, right: 56, bottom: 22, left: 4 };
  const priceH = height - volH - pad.top - pad.bottom - 10;
  const n = bars.length;
  const step = (width - pad.left - pad.right) / n;
  const candleW = Math.max(1.5, step * 0.6);

  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const maxP = Math.max(...highs);
  const minP = Math.min(...lows);
  const range = maxP - minP || 1;
  const yPrice = (p) => pad.top + priceH - ((p - minP) / range) * priceH;

  const maxVol = Math.max(...bars.map((b) => b.volume || 0), 1);
  const volTop = pad.top + priceH + 14;
  const yVolH = (v) => (v / maxVol) * volH;

  let svg = `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" class="candle-svg" preserveAspectRatio="none">`;

  for (let i = 0; i <= 3; i++) {
    const p = minP + (range * i) / 3;
    const y = yPrice(p);
    svg += `<line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${width - pad.right}" y2="${y.toFixed(1)}" class="candle-grid" />`;
    svg += `<text x="${width - pad.right + 6}" y="${(y + 3).toFixed(1)}" class="candle-axis-label">${Math.round(p).toLocaleString()}</text>`;
  }

  bars.forEach((b, i) => {
    const x = pad.left + step * i + step / 2;
    const up = b.close >= b.open;
    const cls = up ? 'up' : 'down';
    svg += `<line x1="${x.toFixed(1)}" y1="${yPrice(b.high).toFixed(1)}" x2="${x.toFixed(1)}" y2="${yPrice(b.low).toFixed(1)}" class="candle-wick ${cls}" />`;
    const bodyTop = yPrice(Math.max(b.open, b.close));
    const bodyBot = yPrice(Math.min(b.open, b.close));
    svg += `<rect x="${(x - candleW / 2).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${candleW.toFixed(1)}" height="${Math.max(1, bodyBot - bodyTop).toFixed(1)}" class="candle-body ${cls}" />`;
    const vh = yVolH(b.volume || 0);
    svg += `<rect x="${(x - candleW / 2).toFixed(1)}" y="${(volTop + volH - vh).toFixed(1)}" width="${candleW.toFixed(1)}" height="${vh.toFixed(1)}" class="candle-vol ${cls}" />`;
  });

  const labelCount = Math.min(6, n);
  for (let i = 0; i < labelCount; i++) {
    const idx = Math.round((i * (n - 1)) / Math.max(1, labelCount - 1));
    const x = pad.left + step * idx + step / 2;
    svg += `<text x="${x.toFixed(1)}" y="${height - 6}" class="candle-axis-label" text-anchor="middle">${bars[idx].time.slice(5)}</text>`;
  }

  svg += '</svg>';
  container.innerHTML = svg;
  container.style.position = 'relative';

  const tooltip = document.createElement('div');
  tooltip.className = 'candle-tooltip';
  tooltip.hidden = true;
  container.appendChild(tooltip);

  const hitLayer = document.createElement('div');
  hitLayer.className = 'candle-hit-layer';
  container.appendChild(hitLayer);

  hitLayer.addEventListener('mousemove', (e) => {
    const rect = hitLayer.getBoundingClientRect();
    const ratio = width / rect.width;
    const xPos = (e.clientX - rect.left) * ratio;
    let idx = Math.round((xPos - pad.left - step / 2) / step);
    idx = Math.max(0, Math.min(n - 1, idx));
    const b = bars[idx];
    const cls = b.close >= b.open ? 'up' : 'down';
    tooltip.hidden = false;
    const leftPx = Math.min(rect.width - 150, Math.max(0, (e.clientX - rect.left) + 10));
    tooltip.style.left = `${leftPx}px`;
    tooltip.style.top = '10px';
    tooltip.innerHTML = `
      <div class="ct-date">${b.time}</div>
      <div class="ct-row">O <b>${b.open.toLocaleString()}</b></div>
      <div class="ct-row">H <b>${b.high.toLocaleString()}</b></div>
      <div class="ct-row">L <b>${b.low.toLocaleString()}</b></div>
      <div class="ct-row">C <b class="${cls}">${b.close.toLocaleString()}</b></div>
      <div class="ct-row">V <b>${b.volume.toLocaleString()}</b></div>
    `;
  });
  hitLayer.addEventListener('mouseleave', () => { tooltip.hidden = true; });
}
