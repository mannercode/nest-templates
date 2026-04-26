# Mixed read/write 동시성 측정

**날짜:** 2026-04-24
**스택:** mono (`REPLICAS=8`) + nginx → mongo 3-node RS (1 GiB/node, WT cache 256 MiB) + redis 3-node cluster.
**데이터:** theaters 75K (seed 완료).
**방법:** [`apis/mono/tests/perf/mixed-runner.sh`](../../apis/mono/tests/perf/mixed-runner.sh) — `theater-read` 와 `theater-write` 하네스를 같은 LABEL 로 동시에 띄워 30s steady-state 측정 (warmup 3s). 두 하네스는 keep-alive pool 을 공유하지 않아 TCP 경합은 배제.

## 결과 요약

| Case              | read c | write c | read RPS | write RPS | Total RPS | read p95 | write p95 |
|-------------------|-------:|--------:|---------:|----------:|----------:|---------:|----------:|
| iso-r200          | 200    | 0       | **2416** | —         | 2416      | 116 ms   | —         |
| iso-w100          | 0      | 100     | —        | **3020**  | 3020      | —        | 51 ms     |
| mixed-r100w50     | 100    | 50      | 1563     | 698       | **2261**  | 92 ms    | 103 ms    |
| mixed-r100w100    | 100    | 100     | 1227     | 1165      | **2392**  | 117 ms   | 127 ms    |
| mixed-r200w50     | 200    | 50      | 1841     | 443       | **2284**  | 150 ms   | 164 ms    |
| mixed-r200w100    | 200    | 100     | 1541     | 752       | **2293**  | 178 ms   | 189 ms    |

## 발견

### 1. 합산 이론치 대비 실측 = **42%** (심한 경합)

- `iso-r200` (2416) + `iso-w100` (3020) = **5436 RPS** (이론 합)
- `mixed-r200w100` 실측 = **2293 RPS** → **42.2%**
- 두 워크로드가 서로 자원을 뺏고 있다. 격리된 측정치만 보면 시스템 capacity 를 크게 과대평가하게 됨.

### 2. Write 가 Read 보다 훨씬 많이 깎임

| 지표 | 격리 | mixed-r200w100 | Δ |
|------|------:|---------------:|---:|
| read RPS (c=200 기준) | 2416 | 1541 | **−36 %** |
| write RPS (c=100 기준) | 3020 | 752 | **−75 %** |

Write 는 majority-commit 을 위해 primary + 2 secondaries 의 journal-ack 을 기다린다. Read 가 primary CPU 를 잡고 있으면 write 의 commit-latency 가 튄다. 반대로 write 는 commit 후엔 primary CPU 를 놔주기 때문에 read 는 상대적으로 덜 깎임.

### 3. 병목은 **mongo1 (primary) CPU** — 일관되게 ~200 % 에 천장

각 case 의 docker stats 중간 스냅샷 기준:

| Case            | mongo1 | mongo2 | mongo3 | app 총계 (8 replica) |
|-----------------|-------:|-------:|-------:|---------------------:|
| iso-r200        | 135 %  |   3 %  |   3 %  | ~1046 % (~10 cores)  |
| iso-w100        | 205 %  | 132 %  | 131 %  | ~753 %               |
| mixed-r200w100  | 207 %  |  84 %  |  81 %  | ~823 %               |

- **mongo1 은 어떤 mixed 케이스에서도 ~200-215 %** — 사실상 2 코어가 완전 포화된 상태의 mongod 한계.
- **mongo2/mongo3 는 read 전담 가능성이 100 % 열려 있음** — isolated read 시 3 % 에 불과. Read 가 모두 primary 로만 간 결과 (mongoose 기본 `readPreference: primary`).
- App 과 host CPU 에는 여전히 headroom 이 있다 (host 16 CPU 중 ~13 코어 사용). 앱이 병목이 아님.

### 4. Tail latency 가 두 배 가까이 뛴다

- read p95: 116 ms (iso) → 178 ms (mixed-r200w100) — **+53 %**
- write p95: 51 ms (iso) → 189 ms (mixed-r200w100) — **+270 %**
- write p99: 67 ms → 225 ms — **+236 %**

실 서비스가 mixed 에 가까운 상태에서 돈다고 가정하면, 격리 측정치로 SLO 잡는 건 위험. p99 예산을 최소 2-3× 여유로 두거나, 혼합 부하 기반 기준을 써야 함.

## 의미: 언제 CQRS / readPreference 를 고려해야 하나

Cycle-02 에서 `secondaryPreferred` 가 회귀를 낳았던 건 "그 당시 primary 가 포화되지 않아 capacity lever 가 불필요" 때문이었다 — 지금은 정반대 조건. **mongo2/mongo3 의 유휴 capacity 가 명확하게 존재**하고 primary 가 ceiling 에 부딪혀 있다.

### Phase 1 경계에서 가능한 lever (코드/설정만, 인프라 증설 없이)

1. **`readPreference: secondaryPreferred` 재시도** — 이 mixed 조건에서만. Secondary read 는 stale 가능 (replica lag 범위 내) 이라 "list-style 조회" 에만 적용하고 write 직후 fresh-read 가 필요한 경로는 primary 유지 (`readConcern: 'majority'` 나 per-query override).
2. **CQRS 수준의 read path 분리** — 아예 read 는 별도 connection(secondary 가리키는) 으로 뽑아내고 write 는 primary 전용 connection. mongoose 는 connection 단위 readPreference 가 가능. `@nestjs/cqrs` 의 CommandBus/QueryBus 와 자연스럽게 매핑됨.
3. **Write 측 majority-commit 완화** — `w: 1` 이면 write throughput 이 크게 오르나 primary failover 시 내구성 손실. **사용자 승인 필요**. 비금융 컬렉션 한정 opt-in 이 합리적.

### 수치로 기대할 수 있는 것

Primary 가 write 전용이 되면 write 이론치 ~3020 RPS 유지, 각 secondary 가 ~800-1000 RPS 의 read 감당 가능 가정 시 합산 ~4500-5000 RPS. 현재 mixed-r200w100 의 2293 RPS 대비 **약 2× 개선 여지**.

## 다음 스텝 후보 (사용자 선택)

- **A. secondaryPreferred 재검증** — 이 mixed runner 로 한 번 측정, 정량 확인. 코드 변경 1줄. 위험 낮음 (cycle-02 때 했던 것과 동일).
- **B. CQRS read-model 분리** — NestJS CQRS 로 read 경로를 별도 connection/module 로 격리. 구조적 변경이라 더 큼. A 의 결과가 긍정적이면 이 방향으로 자연스럽게 연결.
- **C. writeConcern 트레이드오프** — 먼저 secondary read 부터 해서 이 옵션이 실제로 필요한지 판단.

A 를 먼저 돌려 숫자 하나 찍고, 그 결과로 B/C 를 결정하는 순서를 권장.
