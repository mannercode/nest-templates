# 아키텍처

## 1. 모노레포 구조

```
nest-seed/
├── libs/              # 공유 라이브러리 (@mannercode/*)
│   ├── common/            # 기본 유틸리티 (Mongoose, Redis, JWT, S3, Logger)
│   ├── microservices/      # MSA 유틸리티 (NATS RPC, Temporal)
│   └── testing/           # 테스트 유틸리티 (HttpTestClient, RpcTestClient)
├── apis/
│   ├── mono/              # 모놀리식 NestJS 시드
│   └── msa/               # 마이크로서비스 아키텍처 시드
└── package.json           # npm workspaces + npm-run-all2 스크립트
```

## 2. 패키지 의존 그래프

```
microservices → common
testing       (독립)
common        (독립)
```

## 3. 패키지 상세

### @mannercode/common

기반 레이어. 모든 NestJS 애플리케이션에서 재사용 가능한 인프라 추상화를 제공한다.

| 모듈           | 주요 export                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------- |
| **mongoose**   | `CrudRepository`, `CrudSchema`, `AppendOnlyRepository`, `AppendOnlySchema`, 페이지네이션 지원 |
| **redis**      | `RedisModule`, 연결 관리 (single/cluster)                                                     |
| **cache**      | `CacheService`, `CacheModule`, 네임스페이스 키, TTL, Lua, `withLock` / `withLockBlocking` 분산 락 |
| **pubsub**     | `PubSubService`, `PubSubModule`, Redis pub/sub 기반 cross-replica 메시지 팬아웃               |
| **auth**       | JWT/Local/Optional Guard, `JwtAuthService`, `@Public()` — [상세](auth.md)                     |
| **s3**         | `S3ObjectService`, 업로드/다운로드, presigned URL                                             |
| **logger**     | `AppLoggerService`, Winston, `HttpExceptionLoggerFilter`, `HttpSuccessLoggerInterceptor`      |
| **pagination** | `PaginationDto`, `PaginationResult`, `OrderBy`                                                |
| **health**     | `RedisHealthIndicator`                                                                        |
| **config**     | `BaseConfigService`                                                                           |
| **validator**  | `Require`, `Verify`, `ensure()`                                                               |
| **utils**      | env, base64, byte, checksum, date, time, http, json, path                                     |

### @mannercode/microservices

분산 시스템을 위한 통신 및 오케스트레이션 레이어.

| 모듈         | 주요 export                                                                               |
| ------------ | ----------------------------------------------------------------------------------------- |
| **logger**   | `RpcExceptionLoggerFilter`, `RpcSuccessLoggerInterceptor` — HTTP 필터를 상속하여 RPC 추가 |
| **rpc**      | `ClientProxyService`, `ClientProxyModule` — NATS RPC, 자동 재시도 (최대 9회, 지수 백오프) |
| **temporal** | `TemporalClientModule`, `TemporalWorkerService` — 워크플로우 번들링 및 라이프사이클 관리  |

### @mannercode/testing

테스트 인프라 레이어.

| 모듈                  | 주요 export                                                                  |
| --------------------- | ---------------------------------------------------------------------------- |
| **test context**      | `createTestContext()`, `createHttpTestContext()` — 격리된 NestJS 테스트 모듈 |
| **http test client**  | `HttpTestClient` — fluent API (`.post().body().created()`)                   |
| **rpc test client**   | `RpcTestClient` — `.expectRequest()`, `.expectError()`                       |
| **infra connections** | `getRedisTestConnection()`, `getMongoTestConnection()` 등                    |
| **jest utilities**    | Mocking, spying, fake timers 헬퍼                                            |

libs 개발·빌드·테스트·릴리스 워크플로우는 [libs 개발 가이드](libs.md) 참조.

---

## 4. SoLA (Service-oriented Layered Architecture)

### 4.1. 시스템 개요

```
Client ── HTTP ──▶ Gateway ──┬──▶ Applications     (비즈니스 로직, 비동기 작업)
                             ├──▶ Cores             (도메인 모델, 데이터 영속성)
                             └──▶ Infrastructures   (외부 서비스 연동)
```

| Layer               | Role                              | Domains                                                                                       |
| ------------------- | --------------------------------- | --------------------------------------------------------------------------------------------- |
| **Gateway**         | API 진입점, 인증(JWT/Local)       | Customers, Movies, Theaters, Booking, Purchase, ShowtimeCreation                              |
| **Applications**    | 비즈니스 오케스트레이션           | ShowtimeCreation, Booking, Purchase, Recommendation                                           |
| **Cores**           | 핵심 도메인 엔터티, 데이터 영속성 | Customers, Movies, Theaters, Showtimes, Tickets, TicketHolding, PurchaseRecords, WatchRecords |
| **Infrastructures** | 외부 서비스 통합                  | Payments, Assets(MinIO)                                                                       |

| Component   | Configuration                                     |
| ----------- | ------------------------------------------------- |
| **MongoDB** | 3-node replica set (27017-27019)                  |
| **Redis**   | 6-node cluster, 3 primary + 3 replica (6379-6384) |
| **MinIO**   | S3-compatible object storage (9000, console 9001) |

### 4.2. 문제: 순환 참조

모듈(또는 서비스) 간 참조에 제약이 없으면, 처음에는 A → B 단방향이었던 관계가 기능 확장 과정에서 B → A 참조가 추가되어 순환 참조로 발전할 수 있다. 이렇게 되면 둘은 사실상 하나로 묶인다. A를 변경하면 B가 영향을 받고, B를 변경하면 다시 A가 영향을 받는다.

### 4.3. 해결: 계층 분리

이 프로젝트에서는 모듈을 세 계층으로 나누고, 순환 참조를 원천적으로 방지한다. 이 구조를 SoLA(Service-oriented Layered Architecture)라 부른다.

SoLA는 본래 마이크로서비스 아키텍처(MSA)를 대상으로 설계되었다. MSA에서는 서비스가 물리적으로 분리되어 있어 같은 계층 간 직접 참조가 불가능하고, 서비스 조합은 오케스트레이터나 API Gateway가 담당한다. SoLA는 이 격리 원칙을 모놀리스 안에서 모듈 단위로도 적용할 수 있다.

모놀리스에서 SoLA를 적용하는 이유는 서비스가 성장하면 MSA로 전환할 수 있기 때문이다. 모놀리스 단계에서부터 모듈 간 격리를 유지하면, 나중에 특정 모듈을 독립 서비스로 분리할 때 코드 레벨의 의존성을 끊는 비용이 최소화된다. 단, MSA 전환에는 네트워크 호출, 분산 트랜잭션, 데이터 일관성 등 코드 분리 외의 비용이 별도로 존재한다.

일반적인 레이어드 아키텍처는 상위 → 하위 참조만 금지하고 같은 계층 간 참조는 허용한다. 그러나 SoLA는 **동일 계층 간 참조도 금지**한다. 같은 계층의 모듈끼리 참조를 허용하면 결국 순환 참조로 발전할 수 있기 때문이다. 여러 모듈을 조합해야 하는 경우에는 반드시 상위 계층에서 조립한다.

```
┌─────────────────────────────────────────┐
│         Application Services            │  유스케이스 조립, 트랜잭션 관리
│  ShowtimeCreation, Booking, Purchase    │
├─────────────────────────────────────────┤
│            Core Services                │  도메인 기본 로직
│  Movies, Theaters, Showtimes, Tickets   │
├─────────────────────────────────────────┤
│        Infrastructure Services          │  외부 시스템 연동
│           Payments, Assets              │
└─────────────────────────────────────────┘
```

**의존 규칙**:

1. **동일 계층 간 참조 금지** — 같은 계층의 서비스끼리는 서로를 알지 못한다
2. 상위 계층만 하위 계층을 참조 가능 (Application → Core → Infrastructure, 화살표는 참조 방향)
3. 하위 계층은 상위 계층을 알지 못한다

### 4.4. 각 계층의 역할

| 계층               | 역할                                                                                        | 참조 가능 대상       |
| ------------------ | ------------------------------------------------------------------------------------------- | -------------------- |
| **Application**    | 사용자 시나리오를 조립한다 (예: 상영시간 생성 → 티켓 생성). 트랜잭션 관리를 주도한다.       | Core, Infrastructure |
| **Core**           | 도메인의 기본 로직을 담당한다 (예: 영화 관리, 극장 관리). 각 서비스는 자신의 DB만 소유한다. | Infrastructure       |
| **Infrastructure** | 결제, 스토리지 등 외부 시스템 연동을 담당한다.                                              | 없음                 |

Application · Domain · Infrastructure 레이어로 객체를 분류하듯이, 모듈 전체도 동일한 원리로 계층을 나누는 것이다.

### 4.5. Application Service 설계

Application Service는 **여러 Core Service를 조합해야 하는 경우**에만 만든다. 단일 Core Service로 처리 가능한 API는 컨트롤러에서 Core Service를 직접 호출한다.

```
# Application Service가 필요한 경우 — 여러 Core를 조합하는 유스케이스
ShowtimeCreationService   → ShowtimesService + MoviesService + TheatersService + TicketsService
BookingService            → ShowtimesService + TicketsService + TicketHoldingService
PurchaseService           → TicketsService + PurchaseRecordsService + PaymentsService

# Application Service가 불필요한 경우 — 단일 Core로 충분
GET /movies/:id           → MoviesService.getMany()
POST /theaters            → TheatersService.create()
```

Application Service는 오케스트레이터 역할에 충실한다. 비즈니스 로직이 복잡해지면 내부 클래스로 책임을 분산시킨다.

#### 컨트롤러의 서비스 주입

하나의 리소스 컨트롤러가 Core Service와 Application Service를 함께 주입할 수 있다. 단순 CRUD는 Core Service를, 여러 도메인을 조합하는 API는 Application Service를 호출한다.

```ts
@Controller('showtimes')
export class ShowtimesHttpController {
    constructor(
        private readonly showtimesService: ShowtimesService, // Core
        private readonly showtimeCreationService: ShowtimeCreationService // Application
    ) {}

    @Get(':showtimeId')
    async get(@Param('showtimeId') showtimeId: string) {
        return this.showtimesService.getMany([showtimeId]) // 단순 조회 → Core 직접
    }

    @Post()
    async create(@Body() body: CreateShowtimesDto) {
        return this.showtimeCreationService.create(body) // 조합 필요 → Application
    }
}
```

단, 복합 유스케이스가 여러 API로 구성되어 독립된 진입점이 필요한 경우에는 별도 컨트롤러와 namespace로 분리할 수 있다 ([REST API 설계](design-guide.md#1-리소스-중심-설계) 참조).

---

## 5. 분산 환경 협력

mono 는 단일 애플리케이션이지만 프로덕션/테스트에서 **4 replica** 로 수평 확장된다. 같은 레플리카가 독점할 수 없는 상태는 Redis 를 매개로 조정한다.

### 5.1. 분산 락 — `cache.withLock` / `cache.withLockBlocking`

- `withLock(key, ttl, fn)` — 경합 시 `{ran: false}` 를 즉시 반환. **중복 실행 방지용** (예: 여러 replica 가 동시에 발화하는 cron 중 하나만 실행).
- `withLockBlocking(key, ttl, fn, {pollMs, waitMs})` — 폴링하며 락이 풀릴 때까지 대기. **동시 요청을 직렬화할 때** 사용.

현재 사용 지점:

| 위치 | 유형 | 목적 |
|---|---|---|
| [AssetsService.cleanupExpiredUploads](../apis/mono/src/infrastructures/services/assets/assets.service.ts) | `withLock` | 4 replica 의 cron 중 한 번만 삭제 작업 실행 |
| [ShowtimeCreationWorkerService](../apis/mono/src/applications/services/showtime-creation/services/showtime-creation-worker.service.ts) | `withLockBlocking` | 겹치는 시간대 saga 의 validate-then-insert race 차단 |
| [PurchaseService.processPurchase](../apis/mono/src/applications/services/purchase/purchase.service.ts) | `withLockBlocking` (ticketIds 기반 키) | 동일 티켓 세트 중복 구매(double-spend) 차단 |

**선택 기준**: `withLock` 은 "피크에 한 번만" 의미. `withLockBlocking` 은 "모든 요청을 순서대로" 의미. race 를 취소하려면 `withLock`, 직렬화가 필요하면 `withLockBlocking`.

### 5.2. Cross-replica 메시지 — `PubSubService`

프로세스 로컬 `EventEmitter2` 는 요청이 도착한 replica 안에서만 이벤트가 전달된다. 다른 replica 의 SSE 클라이언트로 이벤트를 전달하려면 Redis pub/sub 이 필요하다.

`PubSubService` 는 publisher 연결을 `duplicate()` 해서 subscriber 전용 연결을 만들고 (ioredis 제약), 채널별 핸들러 집합을 관리한다. `subscribe` / `unsubscribe` 는 Redis 의 SUBSCRIBE/UNSUBSCRIBE ack 를 기다린 뒤 resolve 한다.

현재 사용 지점:

| 위치 | 목적 |
|---|---|
| [ShowtimeCreationEvents](../apis/mono/src/applications/services/showtime-creation/showtime-creation.events.ts) | saga 상태 변화를 Redis 채널로 publish → 모든 replica 의 subscribe 핸들러가 로컬 RxJS Subject 로 포워드 → SSE 컨트롤러가 스트림 |

### 5.3. Replica 식별 — `x-replica-id` 응답 헤더

[configure-app.ts](../apis/mono/src/config/configure-app.ts) 의 미들웨어가 모든 HTTP 응답에 `x-replica-id: <os.hostname()>` 를 설정한다. 컨테이너 hostname 이 replica 고유 ID 이므로, stress 테스트가 여러 요청이 실제로 서로 다른 replica 에 분산됐는지 검증할 때 사용한다.

---

## 6. 서비스 호출 흐름

### Mono

HTTP 컨트롤러가 서비스를 직접 주입받아 실행한다.

```
┌──────────────────────────┐        ┌──────────────────────────┐
│    HTTP Controller       ├───────>│         Service          │
└──────────────────────────┘        └──────────────────────────┘
```

```
src/
├── controllers/
│   └── movies.http-controller.ts
│
└── cores/
    └── services/
        └── movies/
            └── movies.service.ts
```

### MSA

REST API 호출은 4단계를 거쳐 서비스를 실행한다.

```
┌────────────────────────────┐        ┌──────────────────────────────┐
│    #1 Gateway Controller   │        │          #4 Service          │
│      ┌─────────────────────┤        ├────────────────────────┐     │
│      │  #2 Service Client  ├───────>│  #3 Service Controller │     │
│      └─────────────────────┤        ├────────────────────────┘     │
└────────────────────────────┘        └──────────────────────────────┘
```

```
apps
├── gateway
│   └── controllers
│       └── #1 movies.http-controller.ts
│
└── cores
    └── services
        └── movies
            ├── #2 movies.client.ts
            ├── #3 movies.controller.ts
            └── #4 movies.service.ts
```

---

## 7. ESLint 계층 의존성 검증

`eslint.config.js`의 `no-restricted-imports` 규칙으로 SoLA 계층 위반을 빌드 타임에 감지한다.

**Mono** (`src/`):

| 계층              | 참조 금지 대상                                            |
| ----------------- | --------------------------------------------------------- |
| `controllers`     | 없음 (모든 하위 계층 참조 가능)                           |
| `applications`    | `controllers`                                             |
| `cores`           | `controllers`, `applications`                             |
| `infrastructures` | `controllers`, `applications`, `cores`                    |
| `shared`          | `controllers`, `applications`, `cores`, `infrastructures` |

**MSA** (`src/apps/`):

| 계층              | 참조 금지 대상                                        |
| ----------------- | ----------------------------------------------------- |
| `gateway`         | 없음 (모든 하위 계층 참조 가능)                       |
| `applications`    | `gateway`                                             |
| `cores`           | `gateway`, `applications`                             |
| `infrastructures` | `gateway`, `applications`, `cores`                    |
| `shared`          | `gateway`, `applications`, `cores`, `infrastructures` |

규칙 위반 시 ESLint `warn`으로 보고된다. `npm run lint`로 전체 검사할 수 있다.
