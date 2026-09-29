// KIS Market Data 배치 갱신 대상 종목("Liquid Universe").
// 주의: 이건 KOSPI/KOSDAQ 보통주 전체(~2,500종목)가 아니다 — 현재 아키텍처(정적 호스팅 +
// 30분 배치 + KIS REST rate limit)에서 안정적으로 매일 시세·OHLCV를 수집할 수 있는
// 유동성 상위 종목만 curated로 관리한다. 나머지 종목은 short-selling/investor-flow/DART 등
// 다른 소스에서 이름이 확인될 때만 Flow/Event 기반으로만 스크리닝되고, Technical/RS 점수는
// 계산하지 않는다(Data Coverage로 정직하게 표시).
// sector: Relative Strength 계산(섹터 평균)에 쓰는 대략적 업종 태그.
export const WATCHLIST = [
  // 반도체
  { symbol: '005930', name: '삼성전자', market: 'KOSPI', sector: '반도체' },
  { symbol: '000660', name: 'SK하이닉스', market: 'KOSPI', sector: '반도체' },
  { symbol: '042700', name: '한미반도체', market: 'KOSPI', sector: '반도체' },
  { symbol: '009150', name: '삼성전기', market: 'KOSPI', sector: '반도체' },
  { symbol: '058470', name: '리노공업', market: 'KOSDAQ', sector: '반도체' },
  { symbol: '240810', name: '원익IPS', market: 'KOSDAQ', sector: '반도체' },
  // 2차전지/화학
  { symbol: '373220', name: 'LG에너지솔루션', market: 'KOSPI', sector: '2차전지' },
  { symbol: '006400', name: '삼성SDI', market: 'KOSPI', sector: '2차전지' },
  { symbol: '051910', name: 'LG화학', market: 'KOSPI', sector: '2차전지' },
  { symbol: '003670', name: '포스코퓨처엠', market: 'KOSPI', sector: '2차전지' },
  { symbol: '096770', name: 'SK이노베이션', market: 'KOSPI', sector: '2차전지' },
  { symbol: '247540', name: '에코프로비엠', market: 'KOSDAQ', sector: '2차전지' },
  { symbol: '086520', name: '에코프로', market: 'KOSDAQ', sector: '2차전지' },
  { symbol: '066970', name: '엘앤에프', market: 'KOSDAQ', sector: '2차전지' },
  // 자동차
  { symbol: '005380', name: '현대차', market: 'KOSPI', sector: '자동차' },
  { symbol: '000270', name: '기아', market: 'KOSPI', sector: '자동차' },
  { symbol: '012330', name: '현대모비스', market: 'KOSPI', sector: '자동차' },
  // 플랫폼/인터넷/게임
  { symbol: '035420', name: 'NAVER', market: 'KOSPI', sector: '인터넷' },
  { symbol: '035720', name: '카카오', market: 'KOSPI', sector: '인터넷' },
  { symbol: '323410', name: '카카오뱅크', market: 'KOSPI', sector: '인터넷' },
  { symbol: '259960', name: '크래프톤', market: 'KOSPI', sector: '게임' },
  { symbol: '036570', name: '엔씨소프트', market: 'KOSPI', sector: '게임' },
  // 금융
  { symbol: '105560', name: 'KB금융', market: 'KOSPI', sector: '금융' },
  { symbol: '055550', name: '신한지주', market: 'KOSPI', sector: '금융' },
  { symbol: '086790', name: '하나금융지주', market: 'KOSPI', sector: '금융' },
  { symbol: '316140', name: '우리금융지주', market: 'KOSPI', sector: '금융' },
  { symbol: '032830', name: '삼성생명', market: 'KOSPI', sector: '금융' },
  { symbol: '000810', name: '삼성화재', market: 'KOSPI', sector: '금융' },
  // 바이오
  { symbol: '068270', name: '셀트리온', market: 'KOSPI', sector: '바이오' },
  { symbol: '207940', name: '삼성바이오로직스', market: 'KOSPI', sector: '바이오' },
  { symbol: '196170', name: '알테오젠', market: 'KOSDAQ', sector: '바이오' },
  // 철강/조선/중공업
  { symbol: '005490', name: 'POSCO홀딩스', market: 'KOSPI', sector: '철강' },
  { symbol: '010130', name: '고려아연', market: 'KOSPI', sector: '철강' },
  { symbol: '009540', name: 'HD한국조선해양', market: 'KOSPI', sector: '조선' },
  { symbol: '010140', name: '삼성중공업', market: 'KOSPI', sector: '조선' },
  { symbol: '012450', name: '한화에어로스페이스', market: 'KOSPI', sector: '방산' },
  // 전자/가전
  { symbol: '066570', name: 'LG전자', market: 'KOSPI', sector: '전자' },
  { symbol: '018260', name: '삼성에스디에스', market: 'KOSPI', sector: 'IT서비스' },
  // 유통/소비재
  { symbol: '028260', name: '삼성물산', market: 'KOSPI', sector: '지주/유통' },
  { symbol: '097950', name: 'CJ제일제당', market: 'KOSPI', sector: '소비재' },
  { symbol: '051900', name: 'LG생활건강', market: 'KOSPI', sector: '소비재' },
  // 통신
  { symbol: '017670', name: 'SK텔레콤', market: 'KOSPI', sector: '통신' },
  { symbol: '030200', name: 'KT', market: 'KOSPI', sector: '통신' },
  { symbol: '032640', name: 'LG유플러스', market: 'KOSPI', sector: '통신' },
  // 에너지/유틸리티
  { symbol: '015760', name: '한국전력', market: 'KOSPI', sector: '유틸리티' },
  { symbol: '034730', name: 'SK', market: 'KOSPI', sector: '지주' },
  { symbol: '010950', name: 'S-Oil', market: 'KOSPI', sector: '에너지' },
  // 건설
  { symbol: '000720', name: '현대건설', market: 'KOSPI', sector: '건설' },
  { symbol: '006360', name: 'GS건설', market: 'KOSPI', sector: '건설' },
  // 항공/운송
  { symbol: '003490', name: '대한항공', market: 'KOSPI', sector: '운송' },
];
