# KRX 분석 대시보드

국내·미국 증시 정보를 한 화면에서 보는 개인용 대시보드. GitHub Actions가 30분마다 데이터를 자동 수집해 `data/*.json`으로 커밋하고, GitHub Pages가 정적 사이트로 서빙합니다. 별도 서버 비용 없이 PC 브라우저와 휴대폰 홈 화면(PWA)에서 동일한 주소로 접속합니다.

## 지금 바로 되는 기능 (17/18)

| 카드 | 데이터 소스 |
|---|---|
| 유무상증자 기준일 | DART Open API |
| 전환청구권 신주상장 캘린더 | DART Open API |
| 자사주 매입 캘린더 | DART Open API |
| 내부자 사전공시 | DART Open API |
| KR 기업 실발 전후 | DART(잠정실적 공정공시) + KRX Open API |
| 주식선물 미결제약정 현황 | KRX Open API |
| 주식선물 베이시스(콘탱고/백워데이션) | KRX Open API |
| 한국 공매도 | data.krx.co.kr 공개 위젯 엔드포인트 (키 불필요) |
| 투자주의/경고 스크리너 | KIND 기업공시채널 (키 불필요) |
| 수급 주체 전환 스크리너 | data.krx.co.kr 공개 랭킹 엔드포인트 (키 불필요) |
| 섹터/테마 ETF 리밸런싱 감지 | Naver/Wisereport ETF 구성종목 (키 불필요) |
| 패시브 ETF 정기변경 일정 | 정적 참고 캘린더 (월 단위) |
| 엔비디아 실적 전후 등락률 | Yahoo Finance (키 불필요) |
| 전일 미국장 시황 브리핑 | Yahoo Finance |
| US 미국장 20일 신고가 | Yahoo Finance + S&P500 구성종목 |
| 미국장 50일 신고가 (대형주) | Yahoo Finance + 다우30/나스닥100 |
| US 기업 실발 전후 | Nasdaq 공개 실적캘린더(키 불필요) + Yahoo Finance |

## 아직 준비 중인 기능

- **수출데이터 일평균** — 공식 소스인 TRASS(무역통계) 웹사이트는 봇 방지 토큰이 걸려 있어 자동 수집이 불가합니다. 공공데이터포털(data.go.kr)에서 "관세청 수출입무역통계" API를 무료 신청(본인인증 필요) 후 키를 알려주시면 연동합니다.

### 참고: KRX data.krx.co.kr 로그인 이슈를 우회한 방법

2025년경부터 data.krx.co.kr의 일반 통계화면(`mdiLoader`)은 회원 로그인이 필요하도록 바뀌었습니다(`pykrx` 등 기존 오픈소스 라이브러리도 동일하게 영향받음). 다만 아래 두 계열의 URL은 로그인 없이 그대로 열립니다:

- **`comm/srt/srtLoader`** — 개별 종목 페이지에 삽입되는 공매도 위젯 (예: 공매도 현황)
- **`contents/MDC/MDI/outerLoader`** — 외부 공개용 랭킹류 화면 (투자자별 순매수 상위 등)

두 경우 모두 실제 데이터는 `comm/bldAttendant/getJsonData.cmd`에 `bld=dbms/MDC_OUT/...·_OUT` 형식의 파라미터로 요청해 받아옵니다. KIND(기업공시채널)의 투자주의/경고/위험 종목 지정 내역과 Naver/Wisereport의 ETF 구성종목 데이터도 별도 키 없이 공개되어 있습니다. 자세한 구현은 `scripts/lib/krx-public.mjs`, `scripts/lib/naver-etf.mjs` 참고.

## 로컬에서 실행하기

```bash
npm run fetch:all   # 모든 데이터 수집 (.env.local의 DART_API_KEY 사용)
npm run serve       # http://localhost:8080 에서 미리보기
```

## GitHub에 올려서 자동화하기

1. GitHub에 새 저장소 생성 (Private 권장) 후 이 폴더 내용을 푸시
2. 저장소 **Settings → Secrets and variables → Actions**에서 `DART_API_KEY` 시크릿 추가 (KRX 키가 생기면 `KRX_API_KEY`도 추가)
3. **Settings → Pages**에서 Source를 "Deploy from a branch" → `main` / `(root)`로 설정
4. 몇 분 후 `https://<username>.github.io/<repo>/` 로 접속 가능. `.github/workflows/update-data.yml`이 30분마다 데이터를 갱신합니다.

## 휴대폰 홈 화면에 바로가기 추가

- **iOS(Safari)**: 위 Pages 주소 접속 → 공유 버튼 → "홈 화면에 추가"
- **Android(Chrome)**: 주소 접속 → 메뉴(⋮) → "홈 화면에 추가" / "앱 설치"

PWA 매니페스트가 설정되어 있어 아이콘을 탭하면 브라우저 주소창 없이 앱처럼 열립니다.

## 폴더 구조

```
dashboard/
  index.html, css/, js/      # 프론트엔드 (정적, 빌드 불필요)
  data/                      # 자동 생성되는 JSON (커밋됨)
  scripts/                   # 데이터 수집 Node 스크립트
  .github/workflows/         # 30분마다 실행되는 GitHub Actions
```
