# libs 개발 가이드

패키지 구조와 모듈 목록은 [architecture.md](architecture.md)를 참조한다. 이 문서는 libs의 개발, 빌드, 테스트, 배포 워크플로우를 다룬다.

---

## Scripts

루트에서 실행한다.

| Script              | Description                         |
| ------------------- | ----------------------------------- |
| `npm run build`     | libs 3개 패키지 빌드                |
| `npm test`          | Jest + Testcontainers로 단위 테스트 |
| `npm run lint`      | ESLint 검사                         |
| `npm run format`    | Prettier 포맷팅                     |

---

## 의존성 관리

### npm workspaces

루트 `package.json`의 `"workspaces": ["libs/*", "apis/*"]`로 모노레포를 구성한다. 루트 `node_modules/`에 호이스팅되므로 모든 workspace 패키지가 공유한다.

### 의존성 종류

| 구분               | 배포 포함 | 용도                                              | 예시                         |
| ------------------ | --------- | ------------------------------------------------- | ---------------------------- |
| `dependencies`     | O         | 라이브러리 내부에서만 사용, 소비자와 공유 불필요  | `winston`, `superagent`      |
| `peerDependencies` | X         | 소비자가 설치, 같은 인스턴스를 공유해야 정상 동작 | `@nestjs/common`, `mongoose` |
| `devDependencies`  | X         | 개발/테스트에서만 사용                            | `@mannercode/testing`        |

### devDependencies 루트 통합

libs 3개의 공통 devDependencies(NestJS, TypeScript, 테스트 도구 등)는 루트 `package.json`에서 일괄 관리한다. 각 lib의 `devDependencies`에는 workspace 패키지 참조(`@mannercode/testing`)만 남긴다.

---

## TypeScript 설정

```
libs/
├── tsconfig.base.json       ← 공통 컴파일러 옵션 (strict, decorators, ESNext)
├── tsconfig.json            ← IDE/테스트용: base + paths 별칭 + noEmit
├── tsconfig.build.json      ← 빌드용: base + jest 타입 제외
│
└── {common,testing,microservices}/
    ├── tsconfig.json         ← ../tsconfig.json 상속 (IDE/테스트)
    └── tsconfig.build.json   ← ../tsconfig.build.json 상속 (tsc 빌드)
```

- `tsconfig.json`은 `@mannercode/*` paths 별칭을 정의하여, 빌드 없이 소스 간 직접 참조가 가능하다.
- `tsconfig.build.json`은 `jest` 타입을 제외하고 `dist/`로 출력한다. 테스트 파일(`*.spec.ts`, `__tests__/`)은 빌드에서 제외된다.

---

## 빌드 순서

`microservices`와 `testing`은 `common`에 의존하므로, `npm run build`는 common → microservices/testing 순으로 빌드한다. npm workspaces의 `--workspaces` 플래그로 각 패키지 빌드를 실행한다.

---

## 테스트 인프라

테스트 실행 흐름, 환경 변수, 격리 전략, Jest 설정은 [testing.md](testing.md#7-테스트-인프라) 참조.

---

## ESLint

`libs/eslint.config.js`에서 전체 libs에 적용되는 규칙을 정의한다. ESLint FlatConfig 형식이다.

주요 규칙:

- **import 정렬**: `perfectionist/sort-imports`, `perfectionist/sort-exports` — natural 순서
- **barrel import 강제**: `no-restricted-imports` — 상위 폴더의 서브모듈 직접 import 금지
- **미사용 import 제거**: `unused-imports/no-unused-imports`
- **Promise 안전성**: `no-floating-promises`, `no-misused-promises`, `await-thenable`
- **switch 완전성**: `switch-exhaustiveness-check`
