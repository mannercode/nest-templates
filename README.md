# nest-seed

NestJS 기반 모노레포. 영화 예매 도메인으로 모놀리식(mono)과 마이크로서비스 아키텍처(MSA) 아키텍처 시드를 제공한다.

## 시작하기

### 1. Dev Container 실행

사전 요구 사항: Docker, VS Code (Dev Containers 확장)

```bash
git clone <repository-url>
code nest-seed
```

VS Code에서 `Reopen in Container`를 실행한다.

> 호스트에서 [Git credentials](https://code.visualstudio.com/remote/advancedcontainers/sharing-git-credentials)를 미리 설정한다.

컨테이너는 `.devcontainer/devcontainer.json`으로 구성되며, 주요 설정은 다음과 같다.

- 최소 사양: CPU 4, RAM 16GB, Storage 32GB
- `node:24-slim` 기반, non-root 사용자(`node`)로 실행
- Docker-in-Docker로 컨테이너 내에서 Docker 사용
- 컨테이너 생성 시 `npm install` 자동 실행
- 컨테이너 시작 시 인프라(MongoDB RS, Redis Cluster, MinIO) 자동 기동
- sudo 권한이 필요한 패키지는 `.devcontainer/Dockerfile`에서 설치 (예: `npm i -g npm-check-updates husky @commitlint/cli`)

인프라 시작이 완료될 때까지 터미널 출력을 확인한 후 다음 단계를 진행한다.

### 2. libs 빌드

apis가 libs에 의존하므로 먼저 빌드한다.

```bash
npm run build
```

`all:build` 태스크가 기본 빌드로 등록되어 있어 `⌘⇧B`(macOS) / `⌃⇧B`(Linux)로도 실행할 수 있다.

```jsonc
// .vscode/tasks.json
{
    "label": "all:build",
    "group": { "kind": "build", "isDefault": true },
    "type": "shell",
    "command": "npm run build"
}
```

### 3. 단위 테스트

이 프로젝트는 테스트 코드로 기능을 검증하는 방식을 지향한다. libs는 주로 단위 테스트, apis는 통합 테스트에 가깝다. 특히 MSA는 여러 서비스를 동시에 실행해야 하므로 서버를 띄우고 curl로 확인하는 방식은 한계가 있다.

libs와 apis 전체 단위 테스트를 실행한다.

```bash
npm run test:unit
```

개별 앱만 실행하려면:

```bash
cd apis/mono
npm run test:unit

cd apis/msa
npm run test:unit
```

### 4. E2E 테스트

E2E 테스트는 Docker Compose로 앱을 빌드·실행한 뒤, curl 기반 셸 스크립트로 API를 검증한다.

```bash
cd apis/mono
npm run test:e2e
```

E2E 스펙은 `tests/e2e/specs/` 디렉토리에 `.spec` 셸 스크립트로 작성한다.

```
tests/e2e/
├── run-all.sh              # 전체 스펙 실행
├── run-select.sh           # 스펙 선택 실행 (대화형)
├── assets/                 # 테스트용 파일 (이미지 등)
└── specs/
    ├── _common.fixture     # 공통 셋업
    ├── customers.spec
    ├── movies.spec
    ├── theaters.spec
    ├── booking.spec
    ├── purchases.spec
    └── showtime-creation.spec
```

스펙 파일 예시 (`customers.spec`):

```bash
TEST "Create a customer" \
    201 POST /customers \
    -H 'Content-Type: application/json' \
    -d '{ "name": "customer name", "email": "'${CUSTOMER_EMAIL}'", ... }'

CUSTOMER_ID=$(echo "${BODY}" | jq -r '.id')

TEST "Login customer" \
    200 POST /customers/login \
    -H 'Content-Type: application/json' \
    -d '{ "email": "'${CUSTOMER_EMAIL}'", "password": "password" }'
```

`TEST` 함수는 `설명`, `기대 상태코드`, `HTTP 메서드`, `URL`, `curl 옵션` 순으로 인자를 받고, 상태코드가 일치하지 않으면 FAIL로 보고한다. 실행 결과는 `_output/logs/`에 기록된다.

MSA도 동일한 구조다.

```bash
cd apis/msa
npm run test:e2e
```

### 5. 분산 스트레스 테스트 (mono)

4-replica docker compose 스택을 띄워 cross-replica race 를 검증한다 — SSE 팬아웃, 동시 가입/홀드, saga 중첩, 중복 구매 등. 자세한 내용은 [testing.md#9-분산-스트레스-테스트](docs/testing.md#9-분산-스트레스-테스트).

```bash
cd apis/mono
npm run test:stress-distributed -- <scenario>
# scenario: sse | customer-race | ticket-holding-race | showtime-overlap-race | purchase-double-spend
```

### 6. Mono 앱 실행

```bash
cd apis/mono
npm run dev
```

앱이 시작되면 API를 호출할 수 있다.

```bash
curl http://localhost:3000/movies
```

## 프로젝트 구조

```
nest-seed/
├── libs/                    ← 공유 라이브러리 (npm 패키지)
│   ├── common/              @mannercode/common
│   ├── microservices/       @mannercode/microservices
│   └── testing/             @mannercode/testing
│
├── apis/                    ← 백엔드 API
│   ├── mono/                모놀리식    — NestJS, MongoDB, Redis, BullMQ
│   └── msa/                 마이크로서비스 — NestJS, MongoDB, Redis, NATS, Temporal
│
└── .devcontainer/           ← Dev Container + 개발 인프라
```

## Mono vs MSA

| 항목           | mono                       | msa                                    |
| -------------- | -------------------------- | -------------------------------------- |
| 서비스         | 1 (단일 프로세스)          | 4 (Gateway, Apps, Cores, Infra)        |
| 레이어 간 통신 | 직접 함수 호출             | NATS RPC                               |
| 비동기 처리    | BullMQ 큐                  | Temporal 워크플로우 (Saga 패턴)        |
| 이벤트         | EventEmitter2 (in-process) | NATS pub/sub                           |
| 인프라         | MongoDB RS + Redis Cluster | + NATS Cluster + Temporal + PostgreSQL |

## 새 프로젝트로 복사해서 사용하기

이 시드를 템플릿으로 사용해 새 프로젝트를 시작할 때 변경해야 할 항목.

### 1. 패키지 이름 / 스코프

| 위치                                  | 현재            | 변경             |
| ------------------------------------- | --------------- | ---------------- |
| `package.json` (root)                 | `nest-seed`     | 새 프로젝트 이름 |
| `apis/mono/package.json`              | `nest-mono`     | 새 mono 이름     |
| `apis/msa/package.json`               | `nest-msa`      | 새 msa 이름      |
| `libs/*/package.json`                 | `@mannercode/*` | `@yourorg/*`     |
| `libs/tsconfig.json` (paths)          | `@mannercode/*` | `@yourorg/*`     |
| `apis/{mono,msa}/package.json` (deps) | `@mannercode/*` | `@yourorg/*`     |

### 2. 환경 / 인프라 식별자

| 위치                       | 현재                                                | 변경           |
| -------------------------- | --------------------------------------------------- | -------------- |
| `apis/mono/.env`           | `PROJECT_ID=nest-mono`                              | 새 ID          |
| `apis/msa/.env`            | `PROJECT_ID=nest-msa`                               | 새 ID          |
| `apis/mono/compose.yml`    | `image: nest-mono`, `container_name: app`           | 새 이름        |
| `apis/msa/compose.yml`     | `image: gateway/applications/cores/infrastructures` | 충돌 시 prefix |
| `.devcontainer/infra/.env` | `nest-bucket` (S3 버킷)                             | 새 버킷 이름   |

### 3. 도메인 코드 교체

`apis/{mono,msa}/src/`의 영화 예매 도메인을 새 도메인으로 교체:

- 모듈/서비스/컨트롤러/모델/DTO: Customers, Movies, Theaters, Showtimes, Tickets, Bookings, Purchases
- 단위 테스트: `apis/{mono,msa}/src/__tests__/`
- e2e 스펙: `apis/{mono,msa}/tests/e2e/specs/*.spec`
- 도메인 용어: `docs/glossary.md`

### 4. CI / 저장소

- `.github/workflows/ci.yaml` — 트리거 분기, 필요 시 시크릿
- README.md의 `git clone <repository-url>` 자리

### 5. 유지할 것 (시드의 핵심)

다음은 그대로 두는 것이 좋다 (스코프 이름만 변경):

- `libs/` 구조와 코드
- SoLA 계층 분리 (controllers/applications/cores/infrastructures)
- 테스트 인프라 (Jest + Testcontainers + e2e shell spec)
- Dev Container 구성
- ESLint 계층 의존성 검증

### 6. mono만 필요한 경우 (msa 제거)

분산 아키텍처가 필요 없고 모놀리식만 사용하려면 다음을 제거한다.

**삭제할 디렉토리/파일**

| 경로                          | 사유                                                       |
| ----------------------------- | ---------------------------------------------------------- |
| `apis/msa/`                   | MSA 앱 전체 (Kong 설정 `apis/msa/kong/` 포함, 함께 사라짐) |
| `libs/microservices/`         | NATS RPC, Temporal 래퍼 (msa 전용)                         |
| `libs/testing-microservices/` | NATS/Temporal 테스트 헬퍼 (msa 전용)                       |
| `.devcontainer/infra/msa/`    | NATS, Temporal, PostgreSQL 인프라                          |

**수정할 파일**

| 파일                              | 변경 내용                                                                                |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| `package.json` (root)             | `@mannercode/microservices`, `@mannercode/testing-microservices` 의존성 제거 (있다면)    |
| `libs/tsconfig.json`              | `@mannercode/microservices`, `@mannercode/testing-microservices` paths 항목 제거         |
| `.devcontainer/devcontainer.json` | `runArgs`에서 `--env-file .devcontainer/infra/msa/.env` 두 줄 제거                       |
| `.devcontainer/infra/reset.sh`    | `cd msa && docker compose up -d` 및 `msa-setup` 관련 라인 제거                           |
| `README.md`                       | "Mono vs MSA" 표 제거, 본 가이드 섹션 6 제거                                             |
| `docs/architecture.md`            | MSA 관련 섹션 제거 (서비스 호출 흐름 MSA 부분, ESLint MSA 표, microservices 패키지 설명) |
| `docs/decisions.md`               | NATS, Temporal 결정 항목 제거 (또는 "참고용" 표시)                                       |
| `docs/tech-stack.md`              | NATS/Temporal/Kong 채택 항목 정리                                                        |

**검증**

```bash
npm install              # workspace 정리
npm run build            # libs 빌드
npm run lint             # 의존성 깨진 곳 확인
npm run test:unit        # 테스트 통과 확인
```

---

## 문서

- [아키텍처](architecture.md) — 모노레포 구조, SoLA 계층, 서비스 호출 흐름
- [인증](auth.md) — JWT 인증 흐름, Guard 패턴
- [컨벤션](conventions.md) — 네이밍 규칙, 에러 패턴, Import, 커밋 메시지
- [설계 결정](decisions.md) — NATS, Temporal 선택 근거
- [REST API & 엔티티 설계](design-guide.md) — 리소스 중심 설계, 비정규화
- [개발 환경](development.md) — 스크립트, 환경 파일, Dev Container, 트러블슈팅
- [도메인 용어](glossary.md) — 영화 예매 도메인 용어
- [기술 스택](tech-stack.md) — 채택 현황, 우선순위, 거부 목록
- [libs 개발](libs.md) — 빌드, 테스트, 배포 워크플로우
- [테스트](testing.md) — 테스트 구조, Fixture, 인프라, 커버리지
