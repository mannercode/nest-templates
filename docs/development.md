# 개발 환경

## 1. 디렉토리 구조

### Mono

```
src/
├── controllers/          # HTTP API 컨트롤러, 인증
├── applications/         # 비즈니스 로직 서비스 (BullMQ)
├── cores/                # 도메인 모델, 리포지토리
├── infrastructures/      # 외부 서비스 연동 (결제, 파일)
├── config/               # 앱 설정, 비즈니스 규칙(Rules), 파이프, 미들웨어
├── __tests__/            # 단위/통합 테스트
├── tests/e2e/            # E2E 테스트 스펙
└── infra/local/          # 로컬 인프라 Docker Compose
```

### MSA

```
src/
├── config/               # 앱 설정, 비즈니스 규칙(Rules), 파이프, 미들웨어
├── apps/
│   ├── gateway/          # HTTP API 컨트롤러, 인증
│   ├── applications/     # 비즈니스 로직 서비스 (Temporal Workflow)
│   ├── cores/            # 도메인 모델, 리포지토리
│   ├── infrastructures/  # 외부 서비스 연동 (결제, 파일)
│   └── __tests__/        # 단위/통합 테스트
tests/e2e/                # E2E 테스트 스펙
infra/local/              # 로컬 인프라 Docker Compose
```

---

## 2. 스크립트

### Mono

| Script                           | Description                                                       |
| -------------------------------- | ----------------------------------------------------------------- |
| `npm run build`                  | 프로덕션 빌드                                                     |
| `npm run start`                  | 빌드된 앱 실행                                                    |
| `npm run dev`                    | Watch 모드로 개발 실행                                            |
| `npm test`                       | 단위 테스트 실행 (coverage 포함)                                  |
| `npm run test:e2e`               | E2E 테스트 실행 (인프라 + 앱 자동 재시작)                         |
| `npm run test:stress`            | E2E spec 반복 부하 테스트 (단일 인스턴스)                         |
| `npm run test:stress-distributed -- <scenario>` | 4-replica cross-replica 시나리오 테스트 — [testing.md#9-분산-스트레스-테스트](testing.md#9-분산-스트레스-테스트) |
| `npm run lint`                   | TypeScript 타입 체크, ESLint, Prettier 검사                       |
| `npm run format`                 | ESLint 자동 수정 및 Prettier 포맷팅                               |
| `npm run api:reset`              | 앱 서비스 초기화 (down + up + wait)                               |

### MSA

| Script              | Description                                             |
| ------------------- | ------------------------------------------------------- |
| `npm run build`     | 특정 앱 빌드 (`TARGET_APP=cores npm run build`)         |
| `npm run start`     | 빌드된 앱 실행 (`TARGET_APP=cores npm run start`)       |
| `npm run dev`       | Watch 모드로 개발 실행 (`TARGET_APP=cores npm run dev`) |
| `npm test`          | 전체 테스트 실행 (단위 + E2E)                           |
| `npm run test:unit` | 단위 테스트 실행 (coverage 포함)                        |
| `npm run test:e2e`  | E2E 테스트 실행 (인프라 + 앱 자동 재시작)               |
| `npm run lint`      | TypeScript 타입 체크, ESLint, Prettier 검사             |
| `npm run format`    | ESLint 자동 수정 및 Prettier 포맷팅                     |
| `npm run api:reset` | 앱 서비스 초기화 (down + up + wait)                     |

인프라는 Dev Container가 시작 시 자동으로 올린다. 수동 관리가 필요하면 `bash .devcontainer/infra/reset.sh`를 실행한다.

---

## 3. 환경 파일

### `.devcontainer/infra/.env`

Docker 이미지 태그와 인프라 접속 정보(MongoDB, Redis, NATS, MinIO, Temporal)를 통합 관리한다. Dev Container 실행 시 `--env-file`로 컨테이너 환경변수에 주입되므로, 앱과 테스트에서 별도 파일 로딩 없이 `process.env`로 접근 가능하다.

### `apis/mono/.env`, `apis/msa/.env`

앱 전용 설정만 포함한다. 프로젝트 ID, HTTP 포트, 인증, 로그 설정 등이 있다.

### 프로젝트 이름 변경

프로젝트를 포크해서 이름을 바꾸려면 두 곳을 수정한다.

- `.env`의 `PROJECT_ID`
- `package.json`의 `name`

---

## 4. Dev Container

1. 호스트에서 [Git credentials](https://code.visualstudio.com/remote/advancedcontainers/sharing-git-credentials)를 설정한다.
2. VS Code에서 "Reopen in Container" 명령을 실행한다.
3. Dev Container는 `.devcontainer/Dockerfile`(베이스 `node:24-slim`)을 사용하며, `postCreateCommand`로 `npm install`, `postStartCommand`로 인프라를 자동으로 시작한다.
4. Dev Container 안에서도 별도 환경 변수 설정 없이 `npm run test:e2e:mono`를 바로 실행할 수 있다.

---

## 5. VS Code

### 디버그 (`.vscode/launch.json`)

- **Mono**: `npm run dev`를 실행하여 Watch 모드로 앱을 디버깅한다.
- **MSA**: `npm run dev`를 실행하며 `TARGET_APP`을 선택한다.
    - 선택지: `applications`, `cores`, `infrastructures`

### 작업 (`.vscode/tasks.json`)

| Task            | Description                   |
| --------------- | ----------------------------- |
| `all:test:unit` | `npm run test:unit` 실행.     |
| `mono:test:e2e` | `npm run test:e2e:mono` 실행. |

---

## 6. Entry File 구조

환경별 엔트리 파일을 분리하여 `process.env.NODE_ENV` 분기를 사용하지 않는다.

- `development.ts` — 개발 환경 엔트리
- `main.ts` — 공통 부트스트랩 로직
- `production.ts` — 프로덕션 환경 엔트리

**Mono** — `src/` 디렉터리에 엔트리 파일이 존재한다.

```json
// nest-cli.json — 개발 환경
"entryFile": "development"
```

**MSA** — 각 앱 디렉터리에 엔트리 파일이 존재한다.

```json
// nest-cli.json — 개발 환경
"entryFile": "apps/cores/development"
```

```js
// webpack.config.js — 프로덕션 빌드
entry: path.resolve(dirname, 'production.ts')
```

---

## 7. ESM Modules

NestJS는 CommonJS 모듈 시스템을 사용하지만, Node.js >= 22에서는 CommonJS와 ESM을 동시에 지원하므로 호환성 문제가 없다.

그러나 Jest는 아직 ESM을 완전히 지원하지 않으므로, ESM 전용 모듈(예: `chalk`)을 사용할 때는 `jest.config.ts`에 등록해야 한다.

```ts
{
    transformIgnorePatterns: ['!node_modules/(?!chalk)']
}
```

---

## 8. 새 Core 서비스 추가 절차

Core 서비스(예: `FooService`)를 추가하는 경우를 예시로 설명한다. Applications/Infrastructures도 동일한 패턴을 따른다.

### 1단계: 디렉터리 및 파일 생성

**Mono:**

```
src/cores/services/foos/
├── foo.ts                        # 도메인 모델
├── foos.module.ts
├── foos.service.ts
├── foos.repository.ts            # MongoDB 리포지토리
├── errors.ts                     # FooErrors 상수
├── dto/
│   ├── create-foo.dto.ts
│   └── foo.dto.ts
└── index.ts                      # 공개 API 재수출
```

**MSA:**

```
src/apps/cores/services/foos/
├── foo.ts                        # 도메인 모델
├── foos.module.ts
├── foos.controller.ts            # NATS RPC 컨트롤러
├── foos.service.ts
├── foos.repository.ts            # MongoDB 리포지토리
├── foos.client.ts                # 다른 서비스에서 사용할 클라이언트
├── errors.ts                     # FooErrors 상수
├── dto/
│   ├── create-foo.dto.ts
│   └── foo.dto.ts
└── index.ts                      # 공개 API 재수출
```

### 2단계: 모듈 등록

**Mono** — `src/cores/cores.module.ts`의 `imports` 배열에 `FoosModule`을 추가한다. `FoosModule`은 `FoosService`를 `exports`해야 다른 계층에서 사용할 수 있다.

```typescript
@Module({
    exports: [FoosService],
    imports: [
        /* ... */
    ],
    providers: [FoosService, FoosRepository]
})
export class FoosModule {}
```

**MSA** — `src/apps/cores/cores.module.ts`의 `imports` 배열에 `FoosModule`을 추가한다.

```typescript
@Module({
    imports: [
        // ... 기존 모듈
        FoosModule
    ]
})
export class CoresModule {}
```

### 3단계: HTTP 컨트롤러 노출

- **Mono**: HTTP 컨트롤러에서 `FoosService`를 직접 주입하여 사용한다.
- **MSA**: 해당 도메인을 소유한 앱(예: `cores` 또는 `applications`)에 `*.http-controller.ts`를 추가하고 모듈에 등록한다. Kong이 path 기반으로 라우팅한다.

---

## 9. 트러블슈팅

### Dev Container 시작 후 인프라 연결 실패

`postStartCommand`로 실행된 인프라 시작이 완료되기 전에 테스트를 실행하면 연결 오류가 발생할 수 있다. 터미널에서 인프라 초기화가 완료될 때까지 기다린 후 테스트를 실행한다.

### `npm test` 실행 시 타임아웃

Testcontainers가 처음 실행될 때 Docker 이미지를 pull한다. 네트워크 환경에 따라 시간이 걸릴 수 있다. `.devcontainer/.env`에 정의된 이미지를 미리 `docker pull`해 두면 단축된다.

### ESLint 계층 규칙 위반 경고

`Layering rule: ...` 메시지가 나타나면 import 경로가 잘못된 계층을 참조하고 있는 것이다. [아키텍처](architecture.md#7-eslint-계층-의존성-검증)의 계층 의존성 규칙 표를 참고하여 import를 수정하거나, 해당 로직을 올바른 계층으로 이동한다.

### MongoDB 트랜잭션 오류 (로컬)

로컬 MongoDB가 replica set으로 구성되지 않으면 트랜잭션이 실패한다. Dev Container를 재시작하면 인프라가 자동으로 초기화되어 3-node replica set이 구성된다.
