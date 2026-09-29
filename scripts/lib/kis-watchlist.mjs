// KIS Market Data 배치 갱신 대상 종목. GitHub Pages 정적 호스팅 + 30분 주기 Actions 배치라는
// 현재 아키텍처 특성상, 사용자가 승인한 대로 "임의 종목 즉시 조회"가 아니라 이 목록만 갱신한다.
// 종목 검색(js/stock-search.js)도 현재는 이 목록 범위 내에서만 동작한다 — 전체 KRX 종목마스터
// 연동은 다음 단계 과제.
export const WATCHLIST = [
  { symbol: '005930', name: '삼성전자', market: 'KOSPI' },
  { symbol: '000660', name: 'SK하이닉스', market: 'KOSPI' },
  { symbol: '373220', name: 'LG에너지솔루션', market: 'KOSPI' },
  { symbol: '207940', name: '삼성바이오로직스', market: 'KOSPI' },
  { symbol: '005380', name: '현대차', market: 'KOSPI' },
  { symbol: '000270', name: '기아', market: 'KOSPI' },
  { symbol: '035420', name: 'NAVER', market: 'KOSPI' },
  { symbol: '035720', name: '카카오', market: 'KOSPI' },
  { symbol: '051910', name: 'LG화학', market: 'KOSPI' },
  { symbol: '006400', name: '삼성SDI', market: 'KOSPI' },
  { symbol: '105560', name: 'KB금융', market: 'KOSPI' },
  { symbol: '055550', name: '신한지주', market: 'KOSPI' },
  { symbol: '032830', name: '삼성생명', market: 'KOSPI' },
  { symbol: '018260', name: '삼성에스디에스', market: 'KOSPI' },
  { symbol: '012330', name: '현대모비스', market: 'KOSPI' },
  { symbol: '028260', name: '삼성물산', market: 'KOSPI' },
  { symbol: '066570', name: 'LG전자', market: 'KOSPI' },
  { symbol: '003670', name: '포스코퓨처엠', market: 'KOSPI' },
  { symbol: '042700', name: '한미반도체', market: 'KOSPI' },
  { symbol: '259960', name: '크래프톤', market: 'KOSPI' },
  { symbol: '068270', name: '셀트리온', market: 'KOSPI' },
  { symbol: '323410', name: '카카오뱅크', market: 'KOSPI' },
  { symbol: '015760', name: '한국전력', market: 'KOSPI' },
  { symbol: '010130', name: '고려아연', market: 'KOSPI' },
];
