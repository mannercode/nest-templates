# 성능 튜닝 요약

2026-04-23 devcontainer 인프라 (Mongo 3-node / Redis 6-node) 튜닝 결과.
검색 API **substring 매칭을 유지**하는 조건에서의 정직한 수치.

## TL;DR — 순수 코드/설정 튜닝 효과 (물리 조건 동등)

동일 환경 (REPLICAS=8, mongo 1 GiB + WT 256 MiB) 에서 pristine 코드 vs 모든 튜닝 적용:

| 지표 c=200                    | pristine (62K) | 모든 튜닝 적용 (130K+) |                    향상 |
| ----------------------------- | -------------: | ---------------------: | ----------------------: |
| theater-read empty filter     |        382 RPS |           **1996 RPS** |       **+422 % (5.2×)** |
| theater-read 필터 (substring) |         49 RPS |                 45 RPS | **사실상 0** (COLLSCAN) |
| theater-write c=100           |       1856 RPS |           **2305 RPS** |               **+24 %** |

**메모리 증설 (mongo 2 GiB + WT 1 GiB)** 은 이 데이터 크기 (100-140K) 에선 거의 의미 없음 (±5 %). cycle 17 에서 **2M+ docs 부터 working set > cache 로 의미있는 이득** 확인 — 소규모 운영은 Phase 1 메모리로 충분.

### 필터 쿼리 개선이 0인 이유

`addRegex(field, value)` 는 `/value/i` 정규식 → mongo `$regex` 에 substring + case-insensitive 조합은 어떤 인덱스도 활용 못 해서 COLLSCAN. `$regex` 자체의 한계. 의미 유지하면서 빠르게 만들려면 별도 검색 경로 (Atlas Search / `$text` / 전용 prefix 엔드포인트) 도입 필요 — 별개 트랙.

## 적용된 변경 (파일 단위)

### 코드

1. **`libs/common/src/mongoose/crud.repository.ts`**
    - `defaultLeanOptions = {}` (기존 `{ virtuals: true }`)
    - `leanToPublic(doc)` 함수 추가 + export — `_id → id` 매핑
    - `findById / findByIds / findWithPagination` 결과를 `leanToPublic` 로 후처리
    - `findWithPagination` 이 빈 필터면 `estimatedDocumentCount` 사용

2. **`libs/common/src/mongoose/mongoose.util.ts`**
    - `QueryBuilder.addRegex` 에 `{ prefix?, caseSensitive? }` 옵션 파라미터 추가. 기본값은 기존 동작 (substring + case-insensitive) 그대로. 현재 사용 호출처 없음 — 향후 prefix-전용 검색 엔드포인트 추가 시 옵트인 용도

3. **`apis/mono/src/config/modules/mongoose-config.module.ts`**
    - mongo pool `(min: 10, max: 50)` (기존 50/200). waitQueueTimeoutMS 5s 유지
    - writeConcern `{ journal: true, w: 'majority' }` 유지 (변경 없음)
    - readPreference default (primary) 유지

4. **`mongoose-lean-virtuals` 패키지 완전 제거**
    - `libs/common/package.json` 에서 dependency 삭제
    - `libs/common/src/mongoose/crud.schema.ts` · `append-only.schema.ts` 에서 `schema.plugin(mongooseLeanVirtuals)` 제거
    - 모든 `.lean({ virtuals: true })` 호출처 (`showtimes.repository.ts:search` · `tickets.repository.ts:search` · `assets.repository.ts:findExpiredIncomplete` · `customers.repository.ts:findByEmailWithPassword`) 를 pure `.lean()` + `leanToPublic` 매핑으로 교체
    - 결과: schema 에 attach 되던 hook 오버헤드와 npm dep 모두 없어짐
    - `theaters/movies/customers` 의 검색 API 는 **substring + case-insensitive 그대로** (한 번 prefix 로 바꿨다가 사용자 요건 확인 후 원복)

5. **각 도메인 model — compound index 추가**
    - `theaters`: `{deletedAt:1, name:1}` + `{name:1}`
    - `movies`: `{deletedAt:1, isPublished:1, title:1}` + `{title:1}`
    - `customers`: `{deletedAt:1, name:1}` + `{deletedAt:1, email:1}`
    - `showtimes` (HardDelete): `{theaterId:1, startTime:1}` + `{sagaId:1}`
    - `tickets`: `{deletedAt:1, showtimeId:1}` + `{sagaId:1}`
    - 현재 검색이 substring regex 라 IXSCAN 활용 못 함. 향후 prefix 기반 엔드포인트 추가하면 즉시 활용 가능 — 유지 비용 작아서 남겨둠
    - 미사용 `name_text` (theaters/customers) 는 drop 함

### 인프라

6. **`.devcontainer/infra/compose.mongo.yml`**
    - mongo 메모리 1 GiB → **2 GiB** (Phase 2)
    - `--wiredTigerCacheSizeGB 0.25 → 1.0` (WT cache = mongo RAM 의 50%, 권장 범위 내)
    - 한 번 1.5 GiB 로 올렸다가 75% 초과는 권장 외라 1.0 으로 원복

7. **`apis/mono/deploy/nginx.conf`**
    - `worker_processes 8` (auto = 16 대비 proxy 용엔 적정)
    - `upstream mono_app { keepalive 128 }` (기존 32)
    - `gzip on; gzip_types application/json; ...` (localhost 에선 -3~-9 %, 실 prod 에선 큰 이득)
    - `proxy_buffers 16 8k; proxy_buffer_size 8k` (기존 8×4k)

### 운영 권장

8. **`REPLICAS=8`** 환경변수로 compose 기동. compose 기본값 4 유지 (CI 보호).
    ```
    REPLICAS=8 docker compose --env-file ../.env up -d --build
    docker restart mono-nginx   # DNS 재해석
    ```

## 폐기된 시도 (다시 시도하지 말 것)

| 시도                                      | 결과                       | 사유                                                                      |
| ----------------------------------------- | -------------------------- | ------------------------------------------------------------------------- |
| `readPreference: secondaryPreferred`      | -3~-12% 회귀               | 이 dataset 에선 mongo primary 포화 안 됨, 분산 이득 < 추가 latency        |
| nginx `access_log off`                    | +5-6% but 디버깅 손실      | stress test 실패 시 replica 추적 불가                                     |
| `writeConcern: { w: 1 }`                  | +5-13% but durability 위험 | primary failover 시 write 소실. 필요하면 컬렉션별 opt-in 으로 (아래 설명) |
| 검색 API substring → prefix+caseSensitive | 필터 +65× but 기능 훼손    | 사용자 substring 필수 확인, cycle-31 원복. 필터 개선은 별도 트랙으로      |
| WT cache 1.0 → 1.5 GiB                    | +10-20% but 권장 50% 초과  | 안정성 우선 — 1.0 으로 원복                                               |

## 안정성 상태

**타협 없음** — 모든 권장 범위 내 또는 원복됨.

- `writeConcern: { w: 'majority', journal: true, wtimeoutMS: 5000 }` 변경 없음
- `readPreference` 기본값 (primary) 유지
- WT cache = mongo RAM 의 50% (권장 상한)
- mongo pool 축소에 `waitQueueTimeoutMS: 5000` — 큐 포화 시 명시적 timeout
- 4종 race 정합성 테스트 PASS (customer-race / ticket-holding-race / showtime-overlap-race / purchase-double-spend)
- 단위 테스트 `libs/common` 417 · `apis/mono` 주요 repo 76 PASS
- tsc + eslint clean

## 의미 변경

**검색 API**: 변경 없음 (substring + case-insensitive 유지).

**pagination `total`**: empty filter 의 경우 `countDocuments` 대신 `estimatedDocumentCount` 사용 — 컬렉션 메타데이터 기반이라 soft-deleted 포함. 실제 items 합보다 약간 클 수 있음 (last-page 에서 items 가 size 보다 적거나 빈 페이지 발생 가능). 필터가 있는 쿼리는 `countDocuments` 유지라 영향 없음. last-page 동작이 UI 계약에 민감하면 재검토 필요.

## 향후 결정 필요 (지금 미적용)

1. **필터 쿼리 속도 개선 트랙** — 현재 45 RPS (COLLSCAN). 개선하려면:
    - Atlas Search / OpenSearch 같은 외부 검색 엔진 도입
    - mongo `$text` 로 전환 (단어 단위 매칭이라 substring 과 의미 다름)
    - 자동완성 같은 UI 전용 **별도 prefix 엔드포인트 추가** — 기존 substring API 는 그대로
    - 모두 API 설계·제품 결정 사항

2. **writeConcern 컬렉션별 opt-in** — 기본은 majority 유지, 잃어도 되는 로그성 컬렉션 (audit log, analytics events, clickstream 등) 이 추가될 때 schema 에 `writeConcern: { w: 1 }` 명시. 현재 이 codebase 에 해당 컬렉션 없어서 적용 대상 없음 — 아이디어로만 메모

3. **mongo 메모리 2 → 3 GiB** — dataset 이 2M+ docs 진입하면 working set 이 WT cache 1 GiB 를 초과하기 시작 (cycle 17 측정). 그 시점에 고려

## 하네스 사용법

측정 하네스는 `apis/mono/tests/perf/` 에 있음:

```bash
# 빈 필터 read
SCENARIO=theater-read CONCURRENCY=200 DURATION_MS=15000 LABEL=adhoc \
  node apis/mono/tests/perf/harness.js

# 필터 read (substring)
SCENARIO=theater-read-name-filter CONCURRENCY=200 \
  node apis/mono/tests/perf/harness.js

# write
SCENARIO=theater-write CONCURRENCY=100 \
  node apis/mono/tests/perf/harness.js

# Redis (customer-refresh — JWT setup 포함)
CONCURRENCY=200 node apis/mono/tests/perf/harness-refresh.js

# 필터 read (customer, JWT 보호)
CONCURRENCY=100 node apis/mono/tests/perf/harness-customer-filter.js

# gzip 클라이언트 시뮬
ACCEPT_GZIP=1 SCENARIO=theater-read CONCURRENCY=200 \
  node apis/mono/tests/perf/harness.js
```

환경변수: `SERVER_URL` (기본 `http://localhost:3000`), `WARMUP_MS` (기본 3000). 결과 JSON 은 `_output/perf/<scenario>-<timestamp>.json` 에 자동 저장.
