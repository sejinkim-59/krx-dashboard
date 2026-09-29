// 실시간 데이터 기반 규칙형 해석 엔진.
// LLM 호출 없이, 실제로 받아온 수치를 규칙에 대입해 매 로드마다 새로 계산한다.
// 모든 insight는 FACT(사실) / INTERPRETATION(해석, 선택) / WATCH(다음에 확인할 것, 선택) 3단으로 구성된다.
// 데이터로 확인되지 않는 원인은 절대 단정하지 않는다 — 근거가 없으면 interpretation/watch를 비운다.
// tone: 'up'(호재/상승 시사) | 'down'(악재/하락 시사) | 'watch'(주의) | 'info'(참고)

function insight(tone, fact, interpretation, watch) {
  return { tone, fact, interpretation: interpretation || null, watch: watch || null };
}

/** 서프라이즈%와 주가반응%로 Beat/Miss × Up/Down 4분면을 분류한다. 실적 서프라이즈 데이터가 있는 카드에서만 사용. */
function classifyReaction(surprisePct, reactionPct) {
  if (surprisePct == null || reactionPct == null || surprisePct === 0) return null;
  const beat = surprisePct > 0;
  const up = reactionPct > 0;
  if (beat && up) return { code: 'beat-up', label: 'Beat + Up', tone: 'up', divergent: false };
  if (beat && !up) return { code: 'beat-down', label: 'Beat + Down', tone: 'watch', divergent: true };
  if (!beat && up) return { code: 'miss-up', label: 'Miss + Up', tone: 'watch', divergent: true };
  return { code: 'miss-down', label: 'Miss + Down', tone: 'down', divergent: false };
}

const INSIGHT_BUILDERS = {
  'short-selling': (data) => {
    const out = [];
    const top = data.items?.[0];
    if (!top) return out;
    if (top.short_ratio_pct >= 30) {
      out.push(insight('watch',
        `${top.name} 공매도 비중 ${top.short_ratio_pct}% — 유니버스 ${data.universe_size}종목 중 최고`,
        '공매도 비중이 높은 종목은 하락에 베팅한 자금이 몰려있다는 뜻입니다.',
        '주가가 반등하면 숏커버링에 의한 단기 급등이 나올 수 있습니다. 이후 며칠간 비중·주가 추이를 확인하세요.'));
    } else {
      out.push(insight('info', `오늘 공매도 비중 1위는 ${top.name}(${top.short_ratio_pct}%)`));
    }
    const heavy = data.items.filter((it) => it.short_ratio_pct >= 20).length;
    if (heavy >= 5) out.push(insight('watch', `공매도 비중 20% 이상 종목 ${heavy}개`, '시장 전반의 하락 베팅이 늘고 있다는 신호일 수 있습니다.'));
    return out;
  },

  'alert-screener': (data) => {
    const out = [];
    const risk = data.categories?.invstriskisu_sub?.count ?? 0;
    const warn = data.categories?.invstwarnisu_sub?.count ?? 0;
    if (risk > 0) out.push(insight('watch', `투자위험 종목 ${risk}건`, '추가 상승 시 매매거래 정지로 이어질 수 있는 최상위 경고 단계입니다.', '보유 중이라면 비중 축소 여부를 점검하세요.'));
    if (warn > 0) out.push(insight('watch', `투자경고 종목 ${warn}건`, '신용거래·미수거래가 제한되는 단계입니다.'));
    if (!risk && !warn) out.push(insight('info', '최근 2주간 투자경고·위험 신규 지정 없음'));
    return out;
  },

  'investor-flow': (data) => {
    const out = [];
    let best = null;
    for (const info of Object.values(data.investors || {})) {
      for (const f of info.flips || []) {
        if (!best || Math.abs(f.swing) > Math.abs(best.swing)) best = { ...f, investor: info.label };
      }
    }
    if (best) {
      const dir = best.recent_net > 0 ? '매도 → 매수' : '매수 → 매도';
      const tone = best.recent_net > 0 ? 'up' : 'down';
      out.push(insight(tone,
        `${best.investor} 수급이 ${best.name}에서 ${dir}로 전환 (변화폭 ${Math.abs(best.swing).toLocaleString()}원)`,
        '추세 전환의 선행 신호로 해석되는 경우가 많습니다.',
        '이후 1~2거래일 같은 방향의 수급이 이어지는지 확인하세요.'));
    }
    const foreignBuy = data.investors?.['9000']?.top_net_buy?.[0];
    if (foreignBuy) out.push(insight('info', `외국인 최근 3거래일 순매수 1위 ${foreignBuy.name}`));
    return out;
  },

  'futures-oi': (data) => {
    const out = [];
    const items = data.items || [];
    const gainer = [...items].sort((a, b) => (b.oi_change ?? -Infinity) - (a.oi_change ?? -Infinity))[0];
    const loser = [...items].sort((a, b) => (a.oi_change ?? Infinity) - (b.oi_change ?? Infinity))[0];
    if (gainer?.oi_change > 0) out.push(insight('watch', `${gainer.name} 미결제약정 전일 대비 +${gainer.oi_change.toLocaleString()}계약 (최대 증가)`, '신규 포지션 유입 구간으로 해석됩니다.'));
    if (loser?.oi_change < 0) out.push(insight('info', `${loser.name} 미결제약정 ${loser.oi_change.toLocaleString()}계약 감소`, '청산 물량이 두드러집니다.'));
    return out;
  },

  'futures-basis': (data) => {
    const out = [];
    const c = data.contango?.[0];
    const b = data.backwardation?.[0];
    if (c) out.push(insight('up', `${c.name} 콘탱고 ${c.basis_pct}% (최대)`, '매수차익거래(현물 매수+선물 매도) 유입 기대가 반영된 구간입니다.'));
    if (b) out.push(insight('down', `${b.name} 백워데이션 ${b.basis_pct}%`, '현물 수급 약화 또는 배당락 기대가 반영됐을 수 있습니다.'));
    return out;
  },

  'capital-increase': (paid, free) => {
    const out = [];
    if (paid.items.length) out.push(insight('down', `유상증자 공시 ${paid.items.length}건`, '신주 발행에 따른 단기 희석 부담이 있는 구간입니다.', '발행방식·배정기준일을 원문에서 확인하세요.'));
    if (free.items.length) out.push(insight('up', `무상증자 공시 ${free.items.length}건`, '권리락 이후 유통주식수 증가 기대로 기준일 전후 단기 수급이 몰리는 경우가 많습니다.'));
    if (!paid.items.length && !free.items.length) out.push(insight('info', '최근 2주간 신규 증자 공시 없음'));
    return out;
  },

  'convertible-bond': (data) => {
    const out = [];
    const items = [...data.items].filter((i) => i.conversion_start).sort((a, b) => a.conversion_start.localeCompare(b.conversion_start));
    const soon = items[0];
    if (soon) out.push(insight('watch',
      `${soon.corp_name} 전환청구기간 ${soon.conversion_start}부터 시작 (전환가 ${Number(soon.conversion_price).toLocaleString()}원)`,
      '현재가가 전환가액보다 높으면 전환 후 매물 출회(오버행) 가능성이 있습니다.',
      '현재 주가를 전환가액과 비교해보세요. 이 데이터에는 실시간 주가가 포함되어 있지 않습니다.'));
    else out.push(insight('info', '최근 2주간 신규 CB 발행결정 공시 없음'));
    return out;
  },

  'treasury-stock': (data) => {
    const out = [];
    const buy = data.items.filter((i) => i.type === '취득');
    const sell = data.items.filter((i) => i.type === '처분');
    if (buy.length) out.push(insight('up', `자사주 취득 공시 ${buy.length}건`, '통상 저평가 인식·주주환원 의지의 신호로 해석됩니다.'));
    if (sell.length) out.push(insight('down', `자사주 처분 공시 ${sell.length}건`, '잠재 매도물량 증가 요인입니다.', '처분 목적을 원문에서 확인하세요.'));
    return out;
  },

  'insider-plan': (data) => {
    if (!data.items.length) return [insight('info', '최근 2주간 임원·주요주주의 신규 거래계획 공시 없음')];
    return [insight('watch',
      `임원·주요주주 거래계획 공시 ${data.items.length}건`,
      null,
      '매수/매도 방향·거래규모는 이 데이터에 포함되어 있지 않습니다 — 원문 공시에서 직접 확인하세요.')];
  },

  'kr-earnings': (data) => {
    const out = [];
    const withR = data.items.filter((i) => i.reaction && i.reaction['D+1'] != null);
    if (!withR.length) return [insight('info', '최근 실적 발표 후 반응을 집계할 데이터가 아직 없음')];
    const best = [...withR].sort((a, b) => b.reaction['D+1'] - a.reaction['D+1'])[0];
    const worst = [...withR].sort((a, b) => a.reaction['D+1'] - b.reaction['D+1'])[0];
    out.push(insight('up', `${best.corp_name} 실적 발표 후 D+1 ${best.reaction['D+1'] > 0 ? '+' : ''}${best.reaction['D+1']}%`, '시장이 긍정적으로 반응했습니다.'));
    out.push(insight('down', `${worst.corp_name} 실적 발표 후 D+1 ${worst.reaction['D+1']}%`, '실적 발표 이후 매물이 나온 것으로 보입니다.'));
    return out;
  },

  'etf-rebalance-schedule': (data) => {
    const sorted = [...data.indices].sort((a, b) => a.next_occurrence.localeCompare(b.next_occurrence));
    const next = sorted[0];
    return [insight('info', `가장 가까운 정기변경은 ${next.name}(${next.next_occurrence})`, '시행 직전 편입 예상 종목에 패시브 자금이 선반영되는 경향이 있습니다.')];
  },

  'sector-etf-rebalance': (data) => {
    if (!data.has_baseline) return [insight('info', '오늘 첫 스냅샷을 수집함 — 내일부터 전일 대비 변화가 감지됩니다.')];
    if (!data.items.length) return [insight('info', `유니버스 ${data.universe_size}개 ETF 중 오늘 감지된 변화 없음`)];
    const nameCount = new Map();
    for (const etf of data.items) {
      for (const a of etf.added) nameCount.set(a.name, (nameCount.get(a.name) || 0) + 1);
    }
    const cross = [...nameCount.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1])[0];
    const out = [];
    if (cross) out.push(insight('up', `${cross[0]} 오늘 ${cross[1]}개 ETF에 동시 신규 편입`, '여러 패시브 자금이 동시에 유입되는 초입 신호일 수 있습니다.'));
    out.push(insight('info', `오늘 구성종목 변화 감지 ETF ${data.changed_etf_count}개`));
    return out;
  },

  'us-market-brief': (data) => {
    const out = [];
    const byId = Object.fromEntries(data.instruments.map((i) => [i.symbol, i]));
    const sp = byId['^GSPC'], nq = byId['^IXIC'], dj = byId['^DJI'], vix = byId['^VIX'];
    if (sp && nq && dj) {
      const dirs = [sp.change_pct, nq.change_pct, dj.change_pct];
      if (dirs.every((d) => d > 0)) out.push(insight('up', '미국 3대 지수 모두 상승 마감', '국내 증시도 개장 초반 우호적인 분위기로 출발할 가능성이 있습니다.'));
      else if (dirs.every((d) => d < 0)) out.push(insight('down', '미국 3대 지수 모두 하락 마감', '국내 증시 개장 초반 약세 출발 가능성이 있습니다.'));
      else out.push(insight('info', '미국 3대 지수 엇갈린 흐름', '업종별 차별화 장세가 이어질 수 있습니다.'));
    }
    if (vix?.change_pct >= 10) out.push(insight('watch', `VIX ${vix.change_pct}% 급등`, '위험자산 전반의 변동성 확대 국면입니다.', '장 초반 변동성 확대에 대비하세요.'));
    return out;
  },

  'us-new-highs': (data) => {
    const out = [];
    const ratio = data.count / data.universe_size;
    if (ratio >= 0.08) out.push(insight('up', `유니버스의 ${(ratio * 100).toFixed(1)}%가 신고가 경신`, '상승폭이 시장 전반에 고르게 퍼져있는 강세 신호입니다.'));
    else if (data.count <= 3) out.push(insight('watch', `신고가 종목 ${data.count}개뿐`, '소수 종목 쏠림 장세일 수 있습니다.'));
    const top = data.items?.[0];
    if (top) out.push(insight('info', `오늘 가장 강한 신고가 종목은 ${top.symbol}(직전구간 대비 +${top.pct_above_prior_window}%)`));
    return out;
  },

  'nvda-earnings': (data) => {
    const out = [];
    const nvda = data.symbols?.NVDA?.reactions;
    if (!nvda?.length) return out;
    const latest = nvda[nvda.length - 1];
    const d1 = latest.reaction['D+1'];
    out.push(insight(d1 >= 0 ? 'up' : 'down', `NVDA 최근 실적(${latest.earnings_date}) 발표 후 D+1 ${d1 >= 0 ? '+' : ''}${d1}%`));
    const peers = ['SOXX', '005930.KS', '000660.KS'].map((s) => data.symbols?.[s]);
    const sameDir = peers.filter((p) => {
      const r = p?.reactions?.[p.reactions.length - 1]?.reaction?.['D+1'];
      return r != null && Math.sign(r) === Math.sign(d1);
    }).length;
    if (sameDir >= 2) out.push(insight('info', `SOXX·삼성전자·SK하이닉스 중 ${sameDir}개가 NVDA와 같은 방향`, '반도체 밸류체인 동조화가 강한 구간입니다.'));
    else out.push(insight('watch', 'NVDA 실적 반응이 국내 반도체주로 크게 전이되지 않음', null, '개별 종목 재료를 별도로 확인하세요.'));
    return out;
  },

  'us-earnings': (data) => {
    const out = [];
    const withR = data.items.filter((i) => i.reaction?.['D+1'] != null && i.surprise_pct != null);
    const divergent = withR
      .map((i) => ({ ...i, cls: classifyReaction(i.surprise_pct, i.reaction['D+1']) }))
      .filter((i) => i.cls?.divergent);
    if (divergent.length) {
      const top = divergent[0];
      const beat = top.surprise_pct > 0;
      out.push(insight('watch',
        `${top.symbol} 서프라이즈 ${beat ? '+' : ''}${top.surprise_pct}%(${beat ? 'Beat' : 'Miss'})인데 D+1 주가는 ${top.reaction['D+1'] >= 0 ? '+' : ''}${top.reaction['D+1']}% — Reaction Divergence`,
        '실적 결과와 주가 반응이 반대로 움직였습니다. 가이던스·마진·사전 기대치 등 실적 외 요인이 있었을 가능성이 있습니다.',
        '컨퍼런스콜·가이던스 코멘트를 확인하세요. 이 데이터에는 가이던스 정보가 포함되어 있지 않습니다.'));
      if (divergent.length > 1) out.push(insight('watch', `Reaction Divergence(실적·주가 반응 불일치) 종목 ${divergent.length}개`));
    }
    return out;
  },
};

INSIGHT_BUILDERS['us-new-highs-20d'] = INSIGHT_BUILDERS['us-new-highs'];
INSIGHT_BUILDERS['us-new-highs-50d'] = INSIGHT_BUILDERS['us-new-highs'];

function toneMeta(tone) {
  switch (tone) {
    case 'up': return { icon: '▲', cls: 'insight-up' };
    case 'down': return { icon: '▼', cls: 'insight-down' };
    case 'watch': return { icon: '⚠', cls: 'insight-watch' };
    default: return { icon: 'ℹ', cls: 'insight-info' };
  }
}

function usageBox(text) {
  if (!text) return '';
  return `<div class="usage-box"><div class="usage-title">이 지표, 투자에 이렇게 활용하세요</div><p>${text}</p></div>`;
}

/** 최상위 시사점 1개를 FACT / WHY IT MATTERS / WATCH NEXT 3단으로 보여주는 Executive Insight. */
function renderHeadlineCallout(card, insightsList) {
  const list = insightsList || [];
  const head = list[0];
  const tone = head ? head.tone : 'info';
  const fact = head ? head.fact : `${card.title} 데이터를 불러왔습니다.`;
  const interpretation = head ? head.interpretation : null;
  const watch = head ? head.watch : null;
  return `<div class="exec-insight tone-${tone}">
    <div class="exec-row"><span class="exec-tag exec-tag-fact">FACT</span><p>${fact}</p></div>
    ${interpretation ? `<div class="exec-row"><span class="exec-tag exec-tag-why">WHY IT MATTERS</span><p>${interpretation}</p></div>` : ''}
    ${watch ? `<div class="exec-row"><span class="exec-tag exec-tag-watch">WATCH NEXT</span><p>${watch}</p></div>` : ''}
  </div>`;
}

/** 헤드라인으로 뽑히지 않은 나머지 시사점들을 보조 불릿으로. */
function renderBulletSection(insightsList, titleText = '함께 보면 좋은 포인트') {
  if (!insightsList || !insightsList.length) return '';
  const rows = insightsList.map((it) => {
    const { cls } = toneMeta(it.tone);
    const text = it.interpretation ? `${it.fact} — ${it.interpretation}` : it.fact;
    return `<li class="bullet-row ${cls}"><span class="bullet-dot"></span><span>${text}</span></li>`;
  }).join('');
  return `<div class="bullet-section"><div class="bullet-section-title">${titleText}</div><ul class="bullet-list">${rows}</ul></div>`;
}

/** 3~6개의 핵심 수치를 크게 강조해 보여주는 Key Metrics 스트립. items: [{label, value, cls}] */
function renderKeyMetrics(items) {
  const list = (items || []).filter((it) => it && it.value != null && it.value !== '');
  if (!list.length) return '';
  const cells = list.map((it) => `
    <div class="km-cell">
      <span class="km-label">${it.label}</span>
      <span class="km-value ${it.cls || ''}">${it.value}</span>
    </div>`).join('');
  return `<div class="key-metrics">${cells}</div>`;
}
