# Mono App Deployment

Docker Compose로 mono 앱을 멀티 컨테이너로 배포한다.
Node.js는 싱글 스레드이므로 컨테이너 N개 복제 + Nginx 로드밸런서 구성으로 멀티 코어를 활용한다.

MongoDB, Redis 등 인프라는 이미 존재한다고 전제한다.

## 구성

| 파일               | 설명                                                      |
| ------------------ | --------------------------------------------------------- |
| `compose.yml`      | app x N replicas + nginx 로드밸런서                       |
| `nginx.conf`       | least_conn 방식 리버스 프록시, upstream 정보 access log   |
| `test-e2e.sh`      | e2e 테스트 (1회 호출, `deploy/specs/` 스펙 실행)          |
| `test-stress.sh`   | 단일 시나리오 반복 부하 (기존 e2e 스펙을 N회 동시 반복)   |

**분산 스트레스 테스트** (cross-replica race 검증) 는 위치가 다르다: [../tests/stress/](../tests/stress/) — 각 시나리오별 Node 스크립트와 `run.sh` 래퍼. 자세한 내용은 [testing.md#9-분산-스트레스-테스트](../../../docs/testing.md#9-분산-스트레스-테스트) 참조.

## 주요 설정

| 변수          | 기본값 | 설명               |
| ------------- | ------ | ------------------ |
| `REPLICAS`    | 4      | 앱 컨테이너 수     |
| `CLIENTS`     | 20     | 동시 클라이언트 수 |
| `ROUNDS`      | 10     | 반복 횟수          |

인프라 연결은 `host.docker.internal`을 통해 호스트 머신의 기존 서비스에 접근한다.

## `x-replica-id` 응답 헤더

[configure-app.ts](../src/config/configure-app.ts) 의 미들웨어가 모든 HTTP 응답에 `x-replica-id: <os.hostname()>` 를 실어 보낸다. 컨테이너 hostname 이 replica 고유 ID 이므로, nginx 가 실제로 여러 replica 로 분산했는지 클라이언트 쪽에서 검증할 수 있다. 분산 스트레스 테스트가 이 헤더로 cross-replica 커버리지를 확인한다.
