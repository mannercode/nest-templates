# 설계 결정 기록

프로젝트에서 내린 주요 기술/설계 결정과 그 근거를 기록한다.

---

## 1. 메시지 브로커: NATS 선택

> MSA 시드에 해당하는 결정입니다. Mono 시드에서는 NATS를 사용하지 않습니다.

### 결정

서비스 간 메시징 레이어로 **NATS**를 사용한다.

### 근거

NestJS가 지원하는 메시지 브로커 여러 종류를 검토한 결과, NATS가 가장 적합하다고 판단했다.

- 현재까지 활발하게 개발·지원되고 있다.
- JetStream을 사용하면 로깅 시스템 구축 시 Kafka를 대체할 가능성이 있다.
- 성능 확장이 쉽다.
- 가벼워서 운영뿐만 아니라 개발 환경을 구성하기에도 용이하다.

### 대안 검토

**Kafka를 배제한 이유**

- **kafkajs 성능 문제**: `maxWaitTimeInMs`를 설정하는 부분에서 심각한 문제가 발생한다. kafkajs는 무한 루프를 돌면서 메시지가 있는지 계속 확인하고, 메시지가 없으면 `maxWaitTimeInMs`만큼 sleep한다. 그래서 Jest로 테스트를 실행하고 종료할 때 `maxWaitTimeInMs`만큼 대기해야 한다. 즉, 간단한 테스트라도 최소한 `maxWaitTimeInMs`만큼 시간이 소요된다. 무한 루프 구조 자체도 성능에 불리하다. 무엇보다 kafkajs는 2022년에 유지보수가 종료된 것으로 보인다.
- **테스트 시 토픽 생성 문제**: 테스트를 위해 Kafka 컨테이너를 초기화할 때 토픽을 미리 생성해야 한다. 예를 들어 `getCustomer` 메시지를 정의하면 `getCustomer`와 `getCustomer.reply` 두 개의 토픽이 필요하다. 토픽 하나를 생성하는 데 수 초가 걸리므로, 토픽이 많아질수록 대기 시간이 크게 늘어난다. nest-msa에서는 전체 테스트 실행 시 인프라를 초기화하므로 이 문제가 특히 커진다.
- **높은 메모리 사용량**: 최소 broker3, controller3 구성이 필요한데, 각 컨테이너가 1GB 정도를 사용한다. 운영 환경에서는 큰 문제가 되지 않더라도 로컬 개발 환경에서는 부담이 된다.

**그 외 브로커를 배제한 이유**

- **MQTT**: IoT 장치처럼 리소스가 제한된 환경에는 최적화되어 있지만, 대규모 시스템에서는 성능이 부족할 수 있다.
- **RabbitMQ**: 설정과 관리가 복잡하며, 특히 클러스터링이나 고가용성(HA)을 구현하기가 까다롭다.

---

## 2. ESLint: import 중복 감지 전략

### 결정

- **eslint-plugin-import**를 제거하고, ESLint 내장 `no-duplicate-imports` 규칙을 사용한다.
- `@typescript-eslint/consistent-type-imports` 규칙을 제거하고, `import type` 분리를 강제하지 않는다.

### 근거

- **eslint-plugin-import 제거**: ESLint 9+ Flat Config 공식 지원이 없고, ESLint 10과 peer dependency가 충돌한다. (커밋 `593dce1` → Revert `ae222e0`)
- **consistent-type-imports 제거**: 이 규칙은 `import type`을 별도 줄로 분리하도록 강제하는데, 이렇게 하면 같은 모듈에서 import가 두 줄이 되어 `no-duplicate-imports`와 충돌한다. 서버 앱이라 번들 크기가 중요하지 않고, NestJS DI가 런타임 클래스 참조를 많이 사용하므로 `import type`을 쓸 곳이 적어 실익이 없다.
- **no-duplicate-imports 도입**: 같은 모듈에서 import를 여러 줄로 나누는 것을 감지한다. `consistent-type-imports`를 제거했으므로 충돌 없이 사용할 수 있다.

---

## 3. 워크플로우 오케스트레이션: Temporal 선택

> MSA 시드에서는 Temporal을 사용하고, Mono 시드에서는 BullMQ를 사용합니다.

### 결정

분산 트랜잭션(Saga)과 비동기 작업 처리에 **Temporal**을 사용한다.

### 근거

티켓 구매의 Saga 보상 패턴과 상영 일정 일괄 생성처럼 여러 서비스에 걸쳐 실행되는 흐름을 안정적으로 관리할 수단이 필요했다.

- **보상 로직의 명시적 표현**: Temporal 워크플로우는 보상 스택을 코드에 직접 작성하므로, try/catch 수동 Saga보다 흐름을 파악하기 쉽다.
- **자동 재시도와 내구성**: Activity 실패 시 Temporal이 자동으로 재시도하며, 워크플로우 상태가 서버에 영속되어 프로세스 재시작 후에도 이어서 실행된다.
- **테스트 용이성**: Mono에서는 `@temporalio/testing`이 in-process 테스트 서버를 제공하고, MSA에서는 Docker Compose로 Temporal 서버를 실행하여 워크플로우를 검증할 수 있다.
- **활발한 생태계**: Temporal은 활발하게 개발·지원되고 있으며, 다양한 언어 SDK를 제공한다.

### 대안 검토

**BullMQ를 대체한 이유**

- BullMQ는 단순 작업 큐로, Saga 보상 패턴을 직접 구현해야 한다. 작업 실패 시 보상 순서와 멱등성을 개발자가 직접 관리해야 하므로 복잡도가 높다.
- BullMQ Worker에서 여러 서비스를 순차 호출하는 로직이 길어지면 에러 처리 분기가 급격히 늘어난다.
- Temporal은 워크플로우 상태를 서버가 관리하므로, Worker 프로세스가 죽어도 다른 Worker가 이어서 실행할 수 있다. BullMQ는 작업 단위 재시도만 지원한다.

---

## 4. Node.js 옵션: --experimental-vm-modules

### 결정

테스트 실행 시 `NODE_OPTIONS='--experimental-vm-modules'`를 설정한다.

### 근거

AWS SDK v3 (`@aws-sdk/client-s3` 등)이 내부적으로 dynamic import를 사용하는데, Node.js 24에서 VM 모듈 없이 실행하면 `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG` 에러가 발생한다. Jest가 VM 환경에서 테스트를 실행하기 때문에 이 플래그가 필요하다.

### 적용 위치

- `apis/msa/package.json` — `test` 스크립트
- `apis/mono/package.json` — `test` 스크립트
- `package.json` (루트) — `test` 스크립트

---

## 5. Cross-replica 메시지: Redis Pub/Sub (mono)

> Mono 시드에 해당하는 결정입니다. MSA 는 NATS 의 `queue: false` 브로드캐스트로 동일한 문제를 해결합니다.

### 결정

Mono 의 SSE 와 같이 프로세스 경계를 넘어 팬아웃이 필요한 이벤트는 **Redis pub/sub** 을 사용하고, 이를 래핑한 `PubSubService` (libs/common) 를 표준 진입점으로 삼는다.

### 근거

mono 는 프로덕션에서 4 replica 로 수평 확장된다. 프로세스 로컬 `EventEmitter2` 는 이벤트가 발행된 replica 의 구독자에게만 전달되므로, 다른 replica 에 붙은 SSE 클라이언트는 상태 변화를 누락한다. showtime-creation 의 saga 진행 상황을 클라이언트에 스트리밍하려면 cross-replica 전달이 필수다.

Redis 는 이미 cache/lock/BullMQ 용으로 스택에 포함되어 있어 추가 인프라 비용이 없다. ioredis 의 subscribe 모드 연결은 다른 명령을 수행할 수 없으므로, `PubSubService` 는 publisher 연결을 `duplicate()` 해서 subscribe 전용 클론을 둔다.

### 대안 검토

- **EventEmitter2 유지**: cross-replica 전달이 안 됨. SSE 사용 불가.
- **NATS 도입 (mono)**: 브로커를 하나 더 운영해야 함. Redis 로 충분한 요구사항에 과함.
- **sticky session (nginx)**: 세션 경로 고정은 가능하지만 worker 에서 발생한 이벤트는 여전히 cross-replica 여서 근본 해결책이 아님.

---

## 6. 분산 락: `cache.withLock` / `cache.withLockBlocking`

### 결정

여러 replica 가 같은 상태를 놓고 경쟁하는 구간은 **Redis SET NX + 토큰 기반 Lua DEL** 로 만든 분산 락으로 보호한다. 두 변형을 제공한다.

- `withLock(key, ttl, fn)` — 경합 시 `{ran: false}` 즉시 반환 (skip semantics)
- `withLockBlocking(key, ttl, fn, {pollMs, waitMs})` — 폴링 재시도, 타임아웃 시 예외 (serialize semantics)

### 근거

- **`withLock`**: 여러 replica 가 동일한 cron 을 동시에 발화시키는 상황처럼 "한 번만 실행되면 충분" 할 때. 대기 의미 없음.
- **`withLockBlocking`**: 동시에 들어온 요청을 하나씩 처리해야 할 때 (예: 겹치는 시간대 saga 의 validate-then-insert, 같은 티켓 세트의 중복 구매). skip 하면 요청을 거절해야 하므로 UX 가 나빠진다.

BullMQ 는 `concurrency=1` 이어도 **replica 수만큼 worker** 가 병렬로 돈다. 따라서 worker 단위의 직렬화가 아니라 Redis 수준의 직렬화가 필요하다. 실제로 [4f7a961](https://github.com/mannercode/nest-seed/commit/4f7a961) 이전의 purchase 는 20 동시 요청 중 18 개가 성공해 중복 결제가 발생했다.

### 적용 위치

- `AssetsService.cleanupExpiredUploads` — `withLock`
- `ShowtimeCreationWorkerService.processJobData` — `withLockBlocking`
- `PurchaseService.processPurchase` — `withLockBlocking`

### 대안 검토

- **Mongo 트랜잭션 / findOneAndUpdate 필터**: 원자적 상태 전이만 해결. "검증 후 삽입" 같은 복합 단계는 트랜잭션 수준이라 rollback 복잡도가 올라감.
- **Redlock (다중 Redis 마스터)**: Redis 클러스터는 이미 고가용이라 단일 키 SET NX 로 충분. Redlock 복잡도는 과함.
- **BullMQ concurrency 조정**: replica 내부만 직렬화됨. cross-replica 해결 안 됨.

---
