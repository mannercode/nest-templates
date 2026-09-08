# 테스트 실행과 결과 확인

이 파일은 실행 명령과 산출물 위치만 안내한다. 각 계층이 필요한 이유와 보장하는 내용은 [`docs/tests.md`](../docs/tests.md)를 본다.

## 1. 범위

- `pnpm run test` — workspace의 단위·통합 테스트. 브라우저 E2E·실제 race·benchmark는 포함하지 않는다.
- `pnpm run atoz` — 정적 검사, build, 기본 테스트, 브라우저 E2E, 다중 복제본 검증을 포함한 전체 회귀.
- `pnpm run e2e` — production build의 console·user-app 브라우저 흐름.
- `pnpm run race <scenario>` — 다중 API 복제본의 경합·fan-out·장애 복구.
- `pnpm run benchmark` — 같은 머신의 이전 실행과 비교하는 API 성능 측정.

단일 API spec을 빠르게 돌릴 때는 전체 커버리지 게이트를 끄고 파일 패턴을 넘긴다.

```bash
pnpm --filter './apps/api' test users.spec --coverage.enabled=false
```

## 2. 결과

단위·통합 테스트와 race 결과는 터미널에서 확인한다. 브라우저 실패의 trace·screenshot·HTML은 `tests/web/_output/`에 남는다. benchmark는 실행 시각별 `tests/api/benchmark/_output/<YYYYMMDD-HHMMSS>/report.html`과 `summary.json`을 만든다.

race 실패 로그에는 정리 전 컨테이너 상태·자원 사용량과 MongoDB 각 노드의 복제·서버 상태도 남긴다. Test API Race의 `Finish runner diagnostics`는 실패 직전 runner 자원 지표를 출력한다. 상태 조회는 실패 후의 snapshot이며, 복제 지연의 원인은 같은 시각의 DB 로그·runner 지표와 함께 판단한다.

benchmark가 만든 극장 fixture는 개발 MongoDB에 남는다. 초기화하려면 `bash infra/reset.sh`를 실행한다.

## 3. 보조 명령

```bash
pnpm run e2e:list                   # 브라우저 시나리오 목록
pnpm run e2e:ui                     # interactive 브라우저 실행
pnpm run e2e:report                 # 마지막 HTML 보고서
pnpm run race                       # race 시나리오 목록
```
