// AI Stock Selection Engine v0.1 — 모든 가중치/임계값을 한 곳에서 관리한다 (하드코딩 금지).
// 값을 바꾸고 싶으면 이 파일만 수정하면 된다. 엔진 코드는 이 설정을 참조만 한다.

export const UNIVERSE_FILTER = {
  minAvgTradingValue20D: 5_000_000_000, // 20일 평균 거래대금 최소 50억원
  excludeStatusFlags: ['halt', 'warning_issue', 'management_issue'], // market-alerts 등에서 확인되는 경우만 적용
};

// Factor 가중치 (합계 100). 데이터가 없는 Factor는 0점 처리하지 않고
// "Available Weight" 기준으로 재정규화한다 (섹션 10 참고).
export const FACTOR_WEIGHTS = {
  technical: 25,
  flow: 20,
  earningsRevision: 20, // 현재 데이터 Provider 없음 — 항상 MISSING_DATA
  corporateEvent: 15,
  relativeStrength: 10,
  globalReadThrough: 10,
};

// ---- Technical Score 세부 규칙 (raw point 합산 → 0~25 정규화) ----
export const TECHNICAL_RULES = [
  { id: 'close_above_ma20', points: 2, label: 'Close > MA20' },
  { id: 'ma20_above_ma60', points: 3, label: 'MA20 > MA60' },
  { id: 'ma60_above_ma120', points: 3, label: 'MA60 > MA120' },
  { id: 'ma20_slope_positive', points: 3, label: 'MA20 상승 기울기' },
  { id: 'ma60_slope_positive', points: 2, label: 'MA60 상승 기울기' },
  { id: 'near_20d_high', points: 2, label: '20일 신고가 근접(3% 이내)' },
  { id: 'breakout_20d', points: 3, label: '20일 신고가 돌파' },
  { id: 'near_52w_high', points: 2, label: '52주 신고가 근접(5% 이내)' },
  { id: 'volume_ratio_1_5', points: 2, label: '거래량 20일 평균 대비 1.5배 이상' },
  { id: 'volume_ratio_2_0', points: 1, label: '거래량 20일 평균 대비 2.0배 이상 추가' },
  { id: 'market_rs_20d_positive', points: 2, label: '20일 시장 대비 상대강도 양(+)' },
  { id: 'sector_rs_20d_positive', points: 2, label: '20일 섹터 대비 상대강도 양(+)' },
];
export const TECHNICAL_MAX_RAW = TECHNICAL_RULES.reduce((s, r) => s + r.points, 0); // 25

// ---- Relative Strength 세부 규칙 (raw point → 0~10 정규화) ----
export const RS_RULES = [
  { id: 'stock_20d_vs_market_positive', points: 2 },
  { id: 'stock_60d_vs_market_positive', points: 2 },
  { id: 'stock_20d_vs_sector_positive', points: 2 },
  { id: 'sector_20d_vs_market_positive', points: 2 },
  { id: 'sector_breadth_strong', points: 2 }, // 섹터 내 20일 상대강도 양(+) 종목 비율 >= 50%
];
export const RS_MAX_RAW = RS_RULES.reduce((s, r) => s + r.points, 0); // 10

// ---- Flow Score 세부 규칙 (raw point → 0~20 정규화). ratio 계열은 tradingValue/marketCap을
// 아는 종목(KIS 관심종목)에서만 applicable — 모르면 그 규칙만 분모에서 빠진다. ----
export const FLOW_RULES = [
  { id: 'flow_reversal_bullish', points: 8, label: '수급 매도→매수 전환' },
  { id: 'flow_reversal_bearish', points: 4, label: '수급 매수→매도 전환 (주의)' },
  { id: 'flow_accumulation', points: 4, label: '투자주체 순매수 상위 랭크' },
  { id: 'net_buy_to_trading_value_significant', points: 4, label: '순매수/거래대금 비중 유의미' },
  { id: 'net_buy_to_market_cap_significant', points: 4, label: '순매수/시가총액 비중 유의미' },
];
export const FLOW_MAX_RAW = 20; // bullish reversal + accumulation + 두 ratio 규칙 기준 상한
export const FLOW_THRESHOLDS = {
  netBuyToTradingValueSignificant: 0.05, // 순매수/거래대금 5% 이상이면 유의미
  netBuyToMarketCapSignificant: 0.001, // 순매수/시가총액 0.1% 이상
  reversalMinSwingWon: 1_000_000_000, // 전환 신호 최소 변화폭 10억원
  accumulationRank: 10, // top_net_buy 상위 10위 이내면 accumulation 신호
};

// ---- Corporate/Event Score: 경제적 규모를 계산할 수 있는 사건만 점수화한다 (섹션 7).
// 자사주 취득금액·CB 발행금액 등은 현재 DART 수집 필드에 금액이 없어 "정보성 표시"로만
// 다루고 점수에는 반영하지 않는다 — 존재만으로 점수를 주지 않는다는 원칙을 지키기 위함. ----
export const CORPORATE_RULES = [
  { id: 'large_free_distribution', points: 8, label: '무상증자 배정비율 큼 (유동성 개선 Catalyst)' },
  { id: 'dilution_ratio_significant', points: 7, label: '유상증자 희석비율 유의미 (Risk)' },
];
export const CORPORATE_MAX_RAW = CORPORATE_RULES.reduce((s, r) => s + r.points, 0); // 15
export const EVENT_THRESHOLDS = {
  buybackToMarketCapNotable: 0.005, // 자사주 취득 / 시총 0.5% 이상이면 유의미 (금액 데이터 확보 시 사용)
  dilutionToSharesOutstandingNotable: 0.03, // 신주 / 기존 발행주식수 3% 이상이면 유의미
  largeFreeRatio: 0.3, // 무상증자 1주당 배정비율
};

// ---- Data Coverage 규칙 (섹션 11) ----
export const COVERAGE_RULES = {
  minToSelect: 60, // 이 미만이면 Top 5 선정 금지
  lowConfidenceBelow: 80, // 60~80% Low/Medium Confidence, 80%+ Normal
};

// ---- Risk Engine ----
export const RISK_THRESHOLDS = {
  shortRatioSpike: 30, // 공매도 비중 %
  extremeReturn5D: 15, // % — 최근 5일 수익률 절대값이 이보다 크면 과열 경계
  atrRatioExtreme: 0.08, // ATR14 / Close 가 이보다 크면 변동성 과다
};

// ---- 시장 국면별 전략 우선순위 (Market Desk가 생성, Screening 가중치에 반영) ----
export const STRATEGY_CONFIG = {
  'Risk-off': { preferred: ['FLOW_REVERSAL', 'EVENT_DRIVEN', 'BUYBACK'], avoid: ['MOMENTUM'] },
  Neutral: { preferred: ['FLOW_REVERSAL', 'CONFLUENCE'], avoid: [] },
  'Risk-on': { preferred: ['MOMENTUM', 'CONFLUENCE'], avoid: [] },
};

// ---- Candidate Selection 규칙 (섹션 14) ----
export const SELECTION_RULES = {
  minIndependentConfirmation: 2,
  topCandidateCount: 20,
  finalPickCount: 5,
  maxSameStrategyInFinal: 2, // Strategy Diversity — 같은 Setup이 Top5에 3개 이상 몰리지 않게
};

// ---- Global Read-through: Mapping이 존재하는 경우만 Signal 생성 (섹션 9) ----
// 임의로 "해외 종목 상승 -> 국내 아무 종목"으로 연결하지 않는다. 실제로 추적 중인 연결고리만 등록.
export const GLOBAL_MAPPING = [
  {
    globalSymbol: 'NVDA',
    globalKpi: 'Data Center Revenue / 실적 반응',
    chain: 'AI 가속기 수요 → HBM 수요',
    koreanSector: '반도체',
    exposureSymbols: ['000660', '005930'], // SK하이닉스, 삼성전자
  },
];
