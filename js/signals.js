// 오늘의 시그널: 여러 데이터 소스를 규칙 기반으로 훑어 "평소와 다른" 상위 3~5건만 추린다.
// 모든 규칙은 임계값과 실제 수치를 그대로 노출한다 — 불투명한 AI score는 쓰지 않는다.
// 데이터가 없거나 임계값 미달이면 해당 시그널은 그냥 만들어지지 않는다 (강제로 채우지 않음).

async function sigFetchJson(file) {
  const res = await fetch(`data/${file}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`fetch failed: ${file}`);
  return res.json();
}

function signal({ category, cardId, headline, keyMetric, keyMetricCls, why, reason, severity, tone }) {
  return { category, cardId, headline, keyMetric, keyMetricCls: keyMetricCls || '', why, reason, severity, tone: tone || 'watch' };
}

const SIGNAL_DETECTORS = [
  // EARNINGS DIVERGENCE — 서프라이즈와 D+1 주가 반응이 반대 방향
  async () => {
    const data = await sigFetchJson('us-earnings-reaction.json');
    const withR = data.items.filter((i) => i.reaction?.['D+1'] != null && i.surprise_pct != null);
    const divergent = withR
      .map((i) => ({ ...i, cls: classifyReaction(i.surprise_pct, i.reaction['D+1']) }))
      .filter((i) => i.cls?.divergent)
      .sort((a, b) => Math.abs(b.reaction['D+1']) - Math.abs(a.reaction['D+1']));
    const top = divergent[0];
    if (!top) return null;
    const beat = top.surprise_pct > 0;
    return signal({
      category: '미국 실적',
      cardId: 'us-earnings',
      headline: `${top.symbol} — ${beat ? 'Beat' : 'Miss'}했지만 주가 ${top.reaction['D+1'] > 0 ? '상승' : '하락'} (Reaction Divergence)`,
      keyMetric: `${top.reaction['D+1'] > 0 ? '+' : ''}${top.reaction['D+1']}%`,
      keyMetricCls: top.reaction['D+1'] > 0 ? 'up' : 'down',
      why: '실적 서프라이즈와 주가 반응이 반대로 움직였습니다. 가이던스·마진 등 실적 외 요인을 확인할 필요가 있습니다.',
      reason: `서프라이즈 ${beat ? '+' : ''}${top.surprise_pct}% vs D+1 반응 ${top.reaction['D+1'] > 0 ? '+' : ''}${top.reaction['D+1']}% (부호 불일치)`,
      severity: Math.abs(top.reaction['D+1']) * 10,
      tone: 'watch',
    });
  },
  // FLOW REVERSAL — 투자주체 수급 매수/매도 전환 중 최대폭
  async () => {
    const data = await sigFetchJson('investor-flow.json');
    let best = null;
    for (const info of Object.values(data.investors || {})) {
      for (const f of info.flips || []) {
        if (!best || Math.abs(f.swing) > Math.abs(best.swing)) best = { ...f, investor: info.label };
      }
    }
    if (!best) return null;
    const toBuy = best.recent_net > 0;
    return signal({
      category: '수급',
      cardId: 'investor-flow',
      headline: `${best.investor} 수급 전환 — ${best.name}에서 ${toBuy ? '매도 → 매수' : '매수 → 매도'}`,
      keyMetric: formatWonCompact(best.swing),
      keyMetricCls: toBuy ? 'up' : 'down',
      why: '지속되던 수급 흐름이 반전되었으므로 추가 지속 여부를 확인할 필요가 있습니다.',
      reason: `변화폭 ${formatWonCompact(Math.abs(best.swing))} (최근 3일 vs 직전 5일 순매수 부호 반전, 전 종목 중 최대)`,
      severity: Math.min(Math.abs(best.swing) / 1e8, 80),
      tone: toBuy ? 'up' : 'down',
    });
  },
  // SHORT SELLING SPIKE — 공매도 비중이 유니버스 내에서 이례적으로 높음
  async () => {
    const data = await sigFetchJson('short-selling.json');
    const top = data.items?.[0];
    if (!top || top.short_ratio_pct < 30) return null;
    return signal({
      category: '공매도',
      cardId: 'short-selling',
      headline: `${top.name} 공매도 비중 ${top.short_ratio_pct}% — 유니버스 내 최고`,
      keyMetric: `${top.short_ratio_pct}%`,
      keyMetricCls: 'down',
      why: '공매도 비중이 높은 종목은 하락 베팅이 몰려있다는 뜻으로, 반등 시 숏커버링에 의한 단기 급등 가능성이 있습니다.',
      reason: `공매도 비중 ${top.short_ratio_pct}% ≥ 임계값 30% (거래대금 상위 ${data.universe_size}종목 중 1위)`,
      severity: top.short_ratio_pct,
      tone: 'watch',
    });
  },
  // MARKET ALERT — 투자위험 종목 신규 지정
  async () => {
    const data = await sigFetchJson('market-alerts.json');
    const risk = data.categories?.invstriskisu_sub;
    if (!risk || risk.count <= 0) return null;
    return signal({
      category: '투자경보',
      cardId: 'alert-screener',
      headline: `투자위험 종목 ${risk.count}건 지정 (최근 2주)`,
      keyMetric: `${risk.count}건`,
      keyMetricCls: 'down',
      why: '투자위험은 가장 높은 경고 단계로, 추가 상승 시 매매거래 정지로 이어질 수 있습니다.',
      reason: `투자위험(최상위 경고단계) 지정 건수 ${risk.count}건 > 0`,
      severity: 70 + risk.count,
      tone: 'watch',
    });
  },
  // LARGE FREE CAPITAL INCREASE — 무상증자 배정비율이 큰 경우
  async () => {
    const data = await sigFetchJson('dart-capital-increase-free.json');
    let top = null;
    for (const it of data.items) {
      const r = parseFloat(it.ratio_per_share);
      if (Number.isFinite(r) && r >= 0.3 && (!top || r > top.ratio)) top = { ...it, ratio: r };
    }
    if (!top) return null;
    return signal({
      category: '기업 이벤트',
      cardId: 'capital-increase',
      headline: `${top.corp_name} 무상증자 — 1주당 ${top.ratio}주 배정`,
      keyMetric: `1:${top.ratio}`,
      keyMetricCls: 'up',
      why: '유통주식수가 크게 늘어나는 무상증자로, 유동성 개선 기대에 기준일 전후 단기 수급이 몰리는 경우가 많습니다.',
      reason: `1주당 배정비율 ${top.ratio} ≥ 임계값 0.3`,
      severity: top.ratio * 50,
      tone: 'up',
    });
  },
  // FUTURES BASIS EXTREME — 콘탱고/백워데이션이 이례적으로 크게 벌어짐
  async () => {
    const data = await sigFetchJson('krx-futures-basis.json');
    const c = data.contango?.[0];
    const b = data.backwardation?.[0];
    const candidates = [];
    if (c && c.basis_pct >= 3) candidates.push({ item: c, kind: 'contango' });
    if (b && b.basis_pct <= -3) candidates.push({ item: b, kind: 'backwardation' });
    candidates.sort((x, y) => Math.abs(y.item.basis_pct) - Math.abs(x.item.basis_pct));
    const top = candidates[0];
    if (!top) return null;
    const isContango = top.kind === 'contango';
    return signal({
      category: '파생상품',
      cardId: 'futures-basis',
      headline: `${top.item.name} ${isContango ? '콘탱고' : '백워데이션'} ${top.item.basis_pct}% — 이례적 괴리`,
      keyMetric: `${top.item.basis_pct > 0 ? '+' : ''}${top.item.basis_pct}%`,
      keyMetricCls: isContango ? 'up' : 'down',
      why: isContango
        ? '매수차익거래(현물 매수+선물 매도) 유입 기대가 반영된 구간일 수 있습니다.'
        : '현물 수급 약화 또는 배당락 기대가 반영됐을 수 있습니다.',
      reason: `베이시스 ${top.item.basis_pct}% (절대값 ≥ 임계값 3%)`,
      severity: Math.abs(top.item.basis_pct) * 5,
      tone: isContango ? 'up' : 'down',
    });
  },
  // VIX SPIKE — 변동성 급등
  async () => {
    const data = await sigFetchJson('us-market-brief.json');
    const vix = data.instruments.find((i) => i.symbol === '^VIX');
    if (!vix || vix.change_pct < 10) return null;
    return signal({
      category: '매크로',
      cardId: 'us-market-brief',
      headline: `VIX ${vix.change_pct}% 급등 — 변동성 확대`,
      keyMetric: `+${vix.change_pct}%`,
      keyMetricCls: 'down',
      why: '위험자산 전반의 변동성이 확대된 구간으로, 국내 증시도 개장 초반 영향을 받을 수 있습니다.',
      reason: `VIX 등락률 +${vix.change_pct}% ≥ 임계값 10%`,
      severity: vix.change_pct * 3,
      tone: 'watch',
    });
  },
];

async function loadSignals() {
  const section = document.getElementById('signals');
  if (!section) return;
  const results = await Promise.allSettled(SIGNAL_DETECTORS.map((fn) => fn()));
  const list = results
    .filter((r) => r.status === 'fulfilled' && r.value)
    .map((r) => r.value)
    .sort((a, b) => b.severity - a.severity)
    .slice(0, 5);

  if (!list.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  const rows = list.map((s) => {
    const priority = s.severity >= 50 ? 'SIGNAL' : 'WATCH';
    const card = CARDS.find((c) => c.id === s.cardId);
    return `
      <button class="signal-card" data-card-id="${s.cardId}" data-tone="${s.tone}">
        <div class="signal-top">
          <span class="signal-category">${s.category}</span>
          <span class="signal-priority priority-${priority.toLowerCase()}">${priority}</span>
        </div>
        <div class="signal-headline">${s.headline}</div>
        <div class="signal-metric ${s.keyMetricCls}">${s.keyMetric}</div>
        <div class="signal-why"><span class="signal-why-tag">Why it matters</span>${s.why}</div>
        <div class="signal-reason">선정 이유: ${s.reason}</div>
      </button>`;
  }).join('');
  section.innerHTML = `
    <div class="signals-head">
      <h2>오늘의 시그널</h2>
      <p class="panel-context">전체 데이터에서 평소와 다른 상위 ${list.length}건 · rule-based</p>
    </div>
    <div class="signals-rows">${rows}</div>
  `;
  section.querySelectorAll('.signal-card').forEach((btn) => {
    btn.addEventListener('click', () => {
      const card = CARDS.find((c) => c.id === btn.dataset.cardId);
      if (card) openCard(card);
    });
  });
}
