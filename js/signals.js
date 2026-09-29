// 오늘의 시그널: 여러 데이터 소스를 규칙 기반으로 훑어 "평소와 다른" 상위 항목만 추린다.
// 모든 규칙은 임계값과 실제 수치를 그대로 노출한다(reason) — 불투명한 AI score는 쓰지 않는다.
// 데이터가 없거나 임계값 미달이면 해당 시그널은 그냥 만들어지지 않는다 (강제로 채우지 않음).
// 화면에는 editorial briefing(주요 1건 + ranked list)으로 표시하고, badge/카드 반복은 쓰지 않는다.

async function sigFetchJson(file) {
  const res = await fetch(`data/${file}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`fetch failed: ${file}`);
  return res.json();
}

function signal({ type, cardId, entity, line, subline, metric, metricCls, interpretation, watch, reason, severity }) {
  return { type, cardId, entity, line, subline: subline || null, metric, metricCls: metricCls || '', interpretation, watch: watch || null, reason, severity };
}

const SIGNAL_DETECTORS = [
  // REACTION DIVERGENCE — 서프라이즈와 D+1 주가 반응이 반대 방향
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
    const d1 = top.reaction['D+1'];
    return signal({
      type: 'REACTION DIVERGENCE',
      cardId: 'us-earnings',
      entity: top.symbol,
      line: `${beat ? 'Beat' : 'Miss'} ${beat ? '+' : ''}${top.surprise_pct}%에도 D+1 ${d1 > 0 ? '+' : ''}${d1}%`,
      metric: `${d1 > 0 ? '+' : ''}${d1}%`,
      metricCls: d1 > 0 ? 'up' : 'down',
      interpretation: '실적 서프라이즈와 주가 반응이 반대로 움직였습니다. 가이던스·마진 등 실적 외 요인을 확인할 필요가 있습니다.',
      watch: '컨퍼런스콜·가이던스 코멘트 확인',
      reason: `서프라이즈 ${beat ? '+' : ''}${top.surprise_pct}% vs D+1 반응 ${d1 > 0 ? '+' : ''}${d1}% (부호 불일치)`,
      severity: Math.abs(d1) * 10,
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
      type: 'FLOW REVERSAL',
      cardId: 'investor-flow',
      entity: best.name,
      line: `${best.investor} 수급 ${toBuy ? '매도 → 매수' : '매수 → 매도'} 전환`,
      metric: formatWonCompact(best.swing),
      metricCls: toBuy ? 'up' : 'down',
      interpretation: '최근 3거래일 순매도(순매수) 흐름 이후 금일 수급이 반전되었습니다. 추가 지속 여부를 확인할 필요가 있습니다.',
      watch: toBuy ? '추가 매수 지속 여부' : '추가 매도 지속 여부',
      reason: `변화폭 ${formatWonCompact(Math.abs(best.swing))} (최근 3일 vs 직전 5일 순매수 부호 반전, 전 종목 중 최대)`,
      severity: Math.min(Math.abs(best.swing) / 1e8, 80),
    });
  },
  // SHORT SELLING SPIKE — 공매도 비중이 유니버스 내에서 이례적으로 높음
  async () => {
    const data = await sigFetchJson('short-selling.json');
    const top = data.items?.[0];
    if (!top || top.short_ratio_pct < 30) return null;
    return signal({
      type: 'SHORT SELLING SPIKE',
      cardId: 'short-selling',
      entity: top.name,
      line: `공매도 비중 ${top.short_ratio_pct}%`,
      subline: '유니버스 내 최고 수준',
      metric: `${top.short_ratio_pct}%`,
      metricCls: 'down',
      interpretation: '공매도 비중이 높은 종목은 하락 베팅이 몰려있다는 뜻으로, 반등 시 숏커버링에 의한 단기 급등 가능성이 있습니다.',
      watch: '반등 시 숏커버링 여부, 이후 며칠간 비중 추이',
      reason: `공매도 비중 ${top.short_ratio_pct}% ≥ 임계값 30% (거래대금 상위 ${data.universe_size}종목 중 1위)`,
      severity: top.short_ratio_pct,
    });
  },
  // MARKET ALERT — 투자위험 종목 신규 지정
  async () => {
    const data = await sigFetchJson('market-alerts.json');
    const risk = data.categories?.invstriskisu_sub;
    if (!risk || risk.count <= 0) return null;
    return signal({
      type: 'MARKET ALERT',
      cardId: 'alert-screener',
      entity: '투자위험',
      line: `최근 2주 신규 지정 ${risk.count}건`,
      metric: `${risk.count}건`,
      metricCls: 'down',
      interpretation: '투자위험은 가장 높은 경고 단계로, 추가 상승 시 매매거래 정지로 이어질 수 있습니다.',
      watch: '보유 종목 비중 축소 여부 점검',
      reason: `투자위험(최상위 경고단계) 지정 건수 ${risk.count}건 > 0`,
      severity: 70 + risk.count,
    });
  },
  // LARGE FINANCING — 무상증자 배정비율이 큰 경우
  async () => {
    const data = await sigFetchJson('dart-capital-increase-free.json');
    let top = null;
    for (const it of data.items) {
      const r = parseFloat(it.ratio_per_share);
      if (Number.isFinite(r) && r >= 0.3 && (!top || r > top.ratio)) top = { ...it, ratio: r };
    }
    if (!top) return null;
    return signal({
      type: 'LARGE FINANCING',
      cardId: 'capital-increase',
      entity: top.corp_name,
      line: `무상증자 1주당 ${top.ratio}주 배정`,
      metric: `1:${top.ratio}`,
      metricCls: 'up',
      interpretation: '유통주식수가 크게 늘어나는 무상증자로, 유동성 개선 기대에 기준일 전후 단기 수급이 몰리는 경우가 많습니다.',
      watch: '권리락 기준일 전후 수급 확인',
      reason: `1주당 배정비율 ${top.ratio} ≥ 임계값 0.3`,
      severity: top.ratio * 50,
    });
  },
  // BASIS EXTREME — 콘탱고/백워데이션이 이례적으로 크게 벌어짐
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
      type: 'BASIS EXTREME',
      cardId: 'futures-basis',
      entity: top.item.name,
      line: `${isContango ? '콘탱고' : '백워데이션'} ${top.item.basis_pct > 0 ? '+' : ''}${top.item.basis_pct}%`,
      metric: `${top.item.basis_pct > 0 ? '+' : ''}${top.item.basis_pct}%`,
      metricCls: isContango ? 'up' : 'down',
      interpretation: isContango
        ? '매수차익거래(현물 매수+선물 매도) 유입 기대가 반영된 구간일 수 있습니다.'
        : '현물 수급 약화 또는 배당락 기대가 반영됐을 수 있습니다.',
      watch: '만기 임박 시 베이시스 수렴 여부',
      reason: `베이시스 ${top.item.basis_pct}% (절대값 ≥ 임계값 3%)`,
      severity: Math.abs(top.item.basis_pct) * 5,
    });
  },
  // VIX SPIKE — 변동성 급등
  async () => {
    const data = await sigFetchJson('us-market-brief.json');
    const vix = data.instruments.find((i) => i.symbol === '^VIX');
    if (!vix || vix.change_pct < 10) return null;
    return signal({
      type: 'VIX SPIKE',
      cardId: 'us-market-brief',
      entity: 'VIX',
      line: `변동성지수 +${vix.change_pct}% 급등`,
      metric: `+${vix.change_pct}%`,
      metricCls: 'down',
      interpretation: '위험자산 전반의 변동성이 확대된 구간으로, 국내 증시도 개장 초반 영향을 받을 수 있습니다.',
      watch: '장 초반 변동성 확대 대비',
      reason: `VIX 등락률 +${vix.change_pct}% ≥ 임계값 10%`,
      severity: vix.change_pct * 3,
    });
  },
];

function toneClass(metricCls) {
  return metricCls === 'up' ? 'up' : metricCls === 'down' ? 'down' : '';
}

async function loadSignals() {
  const section = document.getElementById('signals');
  if (!section) return;
  const results = await Promise.allSettled(SIGNAL_DETECTORS.map((fn) => fn()));
  const list = results
    .filter((r) => r.status === 'fulfilled' && r.value)
    .map((r) => r.value)
    .sort((a, b) => b.severity - a.severity)
    .slice(0, 5);

  section.hidden = false;
  const fulfilledCount = results.filter((r) => r.status === 'fulfilled').length;
  if (!list.length) {
    const allFailed = fulfilledCount === 0;
    section.innerHTML = `
      <div class="signals-head"><h2>오늘의 시그널</h2></div>
      <p class="signals-empty">${allFailed ? '시그널 데이터를 불러오지 못했습니다 — 잠시 후 새로고침해보세요.' : '오늘은 임계값을 넘는 이례적 시그널이 감지되지 않았습니다 (정상 범위).'}</p>`;
    return;
  }

  const [primary, ...rest] = list;

  const primaryHtml = `
    <button class="signal-primary" data-card-id="${primary.cardId}" title="${primary.reason}">
      <div class="sp-eyebrow"><span class="dot ${toneClass(primary.metricCls)}"></span>${primary.type}</div>
      <div class="sp-entity">${primary.entity}</div>
      <div class="sp-line">${primary.line}</div>
      <div class="sp-metric ${toneClass(primary.metricCls)}">${primary.metric}</div>
      <p class="sp-interpretation">${primary.interpretation}</p>
      ${primary.watch ? `<div class="sp-watch"><span class="sp-watch-label">WATCH</span>${primary.watch}</div>` : ''}
    </button>`;

  const secondaryHtml = rest.length ? `
    <div class="signal-secondary-list">
      ${rest.map((s, i) => `
        <button class="ss-item" data-card-id="${s.cardId}" title="${s.reason}">
          <span class="ss-index">0${i + 2}</span>
          <span class="ss-body">
            <span class="ss-entity">${s.entity}</span>
            <span class="ss-line">${s.line}</span>
            ${s.subline ? `<span class="ss-tag">${s.subline}</span>` : `<span class="ss-tag">${s.type.charAt(0)}${s.type.slice(1).toLowerCase()}</span>`}
          </span>
        </button>`).join('')}
    </div>` : '';

  section.innerHTML = `
    <div class="signals-head"><h2>오늘의 시그널</h2></div>
    <div class="signals-briefing">${primaryHtml}${secondaryHtml}</div>
  `;

  section.querySelectorAll('[data-card-id]').forEach((el) => {
    el.addEventListener('click', () => {
      const card = CARDS.find((c) => c.id === el.dataset.cardId);
      if (card) openCard(card);
    });
  });
}
