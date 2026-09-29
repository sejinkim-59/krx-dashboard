// AI Stock Selection Engine v0.2 — 모든 가중치/임계값을 한 곳에서 관리한다.
// 목적: "현재 점수가 높은 좋은 종목"이 아니라
//       NEW INFORMATION + CHANGE + CATALYST + CONFIRMATION 이 있는 종목을 조기에 발견한다.

export const UNIVERSE_FILTER = {
  minAvgTradingValue20D: 5_000_000_000,
};

// ---- Factor 가중치 (합계 100). Global Read-through는 독립 Factor에서 제거 → Catalyst/Context로만 사용 ----
export const FACTOR_WEIGHTS = {
  novelty: 25,
  catalyst: 20, // = CATALYST_WEIGHTS.timing + CATALYST_WEIGHTS.corporate
  technical: 15,
  flow: 15,
  earningsRevision: 15, // 컨센서스/Revision Provider 없음 — 항상 MISSING_DATA
  relativeStrength: 10,
};

// Catalyst 20점을 "언제 확인 가능한가(timing)"와 "경제적 크기(corporate)"로 나눈다.
// 둘은 서로 다른 정보이므로 Independent Confirmation에서도 별개 그룹(Catalyst / Corporate)으로 센다.
export const CATALYST_WEIGHTS = { timing: 12, corporate: 8 };

// ---- Novelty: 상태(State)가 아니라 최근 처음 발생한 변화(Change)를 평가 ----
// 점수 = basePoints × decay(발생 후 경과 거래일)
export const NOVELTY_RULES = [
  { id: 'ma20CrossAboveMa60', points: 10, label: 'MA20이 MA60 상향돌파' },
  { id: 'priceCrossAboveMa20', points: 6, label: '주가 MA20 회복' },
  { id: 'volumeSpike', points: 5, label: '거래량 20일 평균 대비 급증' },
  { id: 'flowReversal', points: 4, label: '외국인/기관 수급 매수 전환 (가격·거래량 확인)' },
];
export const NOVELTY_DECAY = [
  { maxDays: 2, factor: 1.0, band: 'high' },
  { maxDays: 5, factor: 0.6, band: 'medium' },
  { maxDays: 10, factor: 0.3, band: 'low' },
]; // 그 이후 = 0 (little/no novelty)
export const VOLUME_SPIKE_RATIO = 2.0;

// ---- Catalyst Timing: 향후 ~20거래일 안에 확인 가능한 이벤트 (실제 데이터로 확인 가능한 것만) ----
// 점수는 "투자에 긍정적"인 timing만 준다. CB 전환 개시는 잠재 매도물량이라 Catalyst 목록/Risk에만 표시하고 점수 없음.
export const CATALYST_TIMING_RULES = [
  { id: 'freeIncreaseRecordNear', points: 4, label: '무상증자 배정기준일·신주상장 임박' },
  { id: 'buybackInProgress', points: 3, label: '자사주 취득 기간 진행 중' },
  { id: 'earningsReactionRecent', points: 3, label: '최근 실적발표 후 양(+)의 가격 반응' },
  { id: 'etfInclusion', points: 3, label: '국내 섹터/테마 ETF 신규 편입·비중 확대' },
  { id: 'globalPeerEarnings', points: 2, label: '직접 연결된 해외 Peer 실적 서프라이즈' },
];
export const CATALYST_WINDOW_BUSINESS_DAYS = 20;
export const EARNINGS_RECENT_BUSINESS_DAYS = 10;
export const EARNINGS_REACTION_MIN_PCT = 3;
export const NEW_FILING_BUSINESS_DAYS = 5; // 이 기간 안에 접수된 공시 = "새 정보"
export const PEER_EARNINGS_RECENT_BUSINESS_DAYS = 10;
export const PEER_SURPRISE_MIN_PCT = 5;
// 현재 종목 단위 Provider가 없어 탐지하지 않는 Catalyst 유형 — 지어내지 않고 명시만 한다.
export const CATALYST_NOT_CONNECTED = [
  'Investor Relations 일정',
  'Large Contract(단일판매·공급계약)',
  'Index Rebalancing (정기변경 월 주기만 수집, 종목별 편입·편출 예고 없음)',
  'Major Customer Event',
  'Policy Event',
  'Share Cancellation(소각)',
];

// ---- Corporate: 공시 존재가 아니라 경제적 크기(비율)로만 점수화 ----
export const CORPORATE_RULES = [
  { id: 'largeFreeDistribution', points: 5, label: '무상증자 배정비율 큼' },
  { id: 'dilutionSmall', points: 3, label: '유상증자 희석비율 제한적' },
];
export const EVENT_THRESHOLDS = {
  largeFreeRatio: 0.3, // 1주당 배정주식수
  dilutionNotable: 0.03, // 신주 / 기존 발행주식수 — 이 이상이면 Risk, 미만이면 제한적
};

// ---- Technical Confirmation (상태 확인용 — 주 점수원이 아니다) ----
export const TECHNICAL_RULES = [
  { id: 'close_above_ma20', points: 2, label: 'Close > MA20' },
  { id: 'ma20_above_ma60', points: 2, label: 'MA20 > MA60' },
  { id: 'ma20_slope_positive', points: 2, label: 'MA20 상승 기울기' },
  { id: 'near_20d_high', points: 2, label: '20일 고점 3% 이내' },
  { id: 'volume_ratio_1_5', points: 2, label: '거래량 20일 평균 1.5배 이상' },
];

// ---- Normalized Flow: 절대금액 금지, 시총/거래대금 대비 비율 + Universe 내 percentile ----
export const FLOW_RULES = [
  { id: 'reversalConfirmedBullish', points: 7, label: '외국인/기관 매수 전환 + 가격·거래량 확인' },
  { id: 'intensityTopPercentile', points: 5, label: '시총 대비 순매수 강도 상위 percentile' },
  { id: 'accumulationConfirmed', points: 3, label: '외국인/기관 순매수 상위 + 가격 하락 없음' },
];
export const FLOW_THRESHOLDS = {
  topPercentile: 90, // percentile >= 90 → 상위 10%
  accumulationRank: 20,
  priceConfirmReturn5D: 0, // 매수 전환이면 5일 수익률 > 0 이어야 확인
  volumeConfirmRatio: 1.3,
};
// 개인(8000) 수급은 단독으로 방향성을 부여하지 않는다 (섹션 5)
export const DIRECTIONAL_INVESTORS = { 9000: '외국인', 7050: '기관합계', 6000: '연기금 등' };
export const RETAIL_INVESTOR_CODE = '8000';

// ---- Relative Strength ----
export const RS_RULES = [
  { id: 'stock_20d_vs_market_positive', points: 3, label: '20일 시장 대비 초과수익' },
  { id: 'stock_20d_vs_sector_positive', points: 3, label: '20일 섹터 대비 초과수익' },
  { id: 'rs_improving', points: 4, label: '상대강도 개선 (5일 > 20일 초과수익)' },
];

// ---- Priced-in Check (단독 판단 아님 — Context / Discovery Penalty) ----
export const PRICED_IN = {
  signalRunUp: 10, // 변화 발생일 이후 +10% 이상 = 이미 일부 반영
  signalRunUpLarge: 25, // 변화 발생일 이후 +25% 이상 = 상당 부분 반영
  runUp20D: 15,
  runUp60D: 30,
  nearHighPct: -5, // 52주 고점 5% 이내
  limitedMove: 5, // 변화 이후(없으면 20일) 수익률 절대값이 이 이하 = "아직 제한적 반응"
};

// ---- Crowding / Obviousness Penalty — Discovery·Event·Inflection Ranking에만 적용 (Market Leader 제외) ----
export const CROWDING_PENALTY = {
  signalRunUp: 6, // 변화 발생 후 이미 +10% 이상
  runUp20D: 8,
  nearHigh: 5,
  staleNoveltyOnly: 4, // novelty 이벤트가 모두 low band 이하
};

// ---- Independent Confirmation (섹션 12) ----
// Factor Group(Novelty/Technical/Flow/Earnings/Corporate/RS/Catalyst)을 센다. 한 Factor 안의 규칙 여러 개는 1개.
// 추가로 "데이터 원천"(가격 / 수급 / 이벤트)도 센다 — 가격 계열(Novelty·Technical·RS)만으로 3개를 채워
// Confluence가 되는 것을 막기 위해, 모든 Pick은 서로 다른 원천 2개 이상을 요구한다.
export const CONFIRMATION_RULES = {
  technicalMinRatio: 0.6, // 해당 Factor 만점 대비 이 비율 이상일 때만 "확인"으로 인정
  rsMinRatio: 0.6,
  flowMinRatio: 0.3,
  noveltyBands: ['high', 'medium'], // 5거래일 이내 변화만 Confirmation으로 인정
  minSources: 2,
};
export const FACTOR_SOURCE = {
  novelty: 'price', technical: 'price', relativeStrength: 'price',
  flow: 'flow',
  catalyst: 'event', corporate: 'event', earningsRevision: 'event',
};

// ---- Data Coverage ----
export const COVERAGE_RULES = {
  minForLeader: 60,
  minForDiscovery: 35, // Discovery는 데이터가 적은 중소형주가 대상이므로 기준을 낮추되 반드시 표시
  lowConfidenceBelow: 70,
};

// ---- Risk Engine ----
export const RISK_THRESHOLDS = {
  shortRatioSpike: 30,
  extremeReturn5D: 15,
  atrRatioExtreme: 0.08,
};

// ---- Discovery / Daily Output 구조 ----
export const DISCOVERY_CONFIG = {
  topMarketCapExclusion: 30,
  // 2단계 Discovery: ① 가격 데이터 없이 1,000+ 종목을 수급/공시 신호로 저비용 pre-screen
  //                 ② 상위 N개만 KIS 시세·OHLCV를 추가 조회 (전체 Universe를 다 조회하지 않는다)
  enrichLimit: 60,
  // 수급 신호가 약해도 긍정적 이벤트(자사주 취득·무상증자·양(+) 실적반응)가 있는 종목은 가격을 확보해야
  // Event-Driven 평가(WHY NOT PRICED)가 가능하다 → 조회 예산 일부를 이벤트 종목에 예약.
  enrichReservedForEvents: 20,
  enrichDelayMs: 400,
  excludeNamePattern: /스팩|제\d+호|리츠|우$|우B$|우\(전환\)$|ETN|ETF/,
};
export const DAILY_SLOTS = [
  { bucket: 'MARKET_LEADER', count: 1 },
  { bucket: 'DISCOVERY', count: 2 },
  { bucket: 'EVENT_DRIVEN', count: 1 },
  { bucket: 'INFLECTION', count: 1 },
];
export const SELECTION_RULES = {
  minIndependentConfirmation: 2,
  confluenceConfirmation: 3,
  topCandidateCount: 20,
  inflectionMaxDist52WHigh: -20, // 52주 고점 대비 -20% 이하에서 새 반전 신호
};

// ---- 시장 국면별 선호 (Market Desk 표시용) ----
export const STRATEGY_CONFIG = {
  'Risk-off': { preferred: ['EVENT_DRIVEN', 'INFLECTION'], avoid: ['MOMENTUM'] },
  Neutral: { preferred: ['DISCOVERY', 'EVENT_DRIVEN'], avoid: [] },
  'Risk-on': { preferred: ['DISCOVERY', 'MARKET_LEADER'], avoid: [] },
};

// ---- Global Peer: 독립 Factor 아님. 매핑된 해외 Peer가 최근 실제로 실적을 발표했을 때만 Catalyst로 사용 ----
// 일반론적 연결("AI 수요 → 반도체 전부")은 등록하지 않는다. 직접 공급/경쟁 관계만.
export const GLOBAL_MAPPING = [
  { globalSymbol: 'NVDA', relation: 'HBM 고객사', exposureSymbols: ['000660'] },
  { globalSymbol: 'MU', relation: '메모리 직접 경쟁사', exposureSymbols: ['000660', '005930'] },
  { globalSymbol: 'TSLA', relation: '배터리 고객사', exposureSymbols: ['373220'] },
  { globalSymbol: 'AAPL', relation: '카메라모듈·기판 고객사', exposureSymbols: ['011070', '009150'] },
];
