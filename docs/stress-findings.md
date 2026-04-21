# 부하 테스트로 드러난 문제와 조치

`apis/mono/tests/` 의 분산 부하 테스트(5 scenario × repeat 50)를 굴리면서 기존 코드·설정에 잠복해 있던 문제들이 드러났다. 각 항목은 **코드/설정이 무엇이 잘못돼 있었는지**, 부하 테스트가 그걸 **어떻게 드러냈는지**, **무엇을 고쳤는지** 순서로 정리한다.

---

## 1. mongoose 커넥션 풀이 부하에 비해 너무 작았다

**무엇이 잘못돼 있었나** — [mongoose-config.module.ts](../apis/mono/src/config/modules/mongoose-config.module.ts) 가 `maxPoolSize` 를 명시하지 않아 기본값 100을 사용하고 있었다. 4 replica × 100 = 400 이지만 한 replica 당 피크 부하가 100을 넘으면 그 replica 에서 즉시 고갈된다.

**드러난 방식** — iter 당 500 concurrent POST 를 쏘는 시나리오(customer-race / ticket-holding)에서 `MongoWaitQueueTimeoutError: Timed out while checking out a connection from connection pool` 가 터지면서 500 응답이 섞여 나왔다.

**조치** — `maxPoolSize: 200` 로 올렸다 ([9bb6664](https://github.com/mannercode/nest-seed/commit/9bb6664)). 실 서비스 부하 수준은 이 이상일 수도 있으니 앞으로 관측치에 따라 재조정 대상.

---

## 2. mongoose 풀이 cold-start 때 비어 있는데 `/health` 는 true 를 반환했다

**무엇이 잘못돼 있었나** — `minPoolSize` 가 기본값 0 이라 부팅 직후 풀이 텅 비어 있는 상태로 `app.listen()` 이 호출된다. Terminus `pingCheck` 는 커넥션 1개만 쓰고 성공하므로 `/health` 가 200 을 반환 → 컨테이너가 "healthy" 로 전환 → nginx 가 트래픽을 붙인다. 첫 burst 에 60+ 요청이 들어오면 풀이 커넥션을 동시에 핸드셰이크하다가 `waitQueueTimeoutMS` 에 걸린다.

**드러난 방식** — 1번 문제를 `maxPoolSize: 200` 으로 고친 뒤에도, 컨테이너 "up 13~16s" 직후 테스트를 쏘면 `MongoWaitQueueTimeoutError` 가 재발했다. 풀 크기 문제가 아니라 **풀이 차오르기 전에 트래픽이 들어오는 문제**였다.

**조치** — `minPoolSize: 50` 을 붙여 모듈 init 단계에서 풀을 미리 채우게 했다 ([a40ea55](https://github.com/mannercode/nest-seed/commit/a40ea55)). healthcheck 가 의미 있는 시그널이 된다.

---

## 3. `autoCreate: false` 가 fresh DB 에서 replica 간 race 를 유발했다

**무엇이 잘못돼 있었나** — mongoose 옵션이 `autoCreate: false`, `autoIndex: false` 였다. 4 replica 가 동시에 존재하지 않는 컬렉션에 첫 insert 를 시도하면 Mongo 서버가 암시적으로 createCollection 을 띄우는데, 여러 replica 가 동시에 띄우면 `WriteConflictException` 이 튄다.

**드러난 방식** — 첫 iteration 에서 간헐적으로 `WriteConflict` 가 떴다. 같은 컬렉션에 replica 2개가 동시에 첫 insert 를 치면 재현됐다.

**조치** — `autoCreate: true`, `autoIndex: true` 로 바꿨다 ([7e59bcd](https://github.com/mannercode/nest-seed/commit/7e59bcd)). 이제 mongoose 가 모듈 init 때 컬렉션·인덱스를 먼저 만들어 두고 트래픽을 받는다.

---

## 4. nginx 에 upstream retry/keepalive 설정이 전혀 없었다

**무엇이 잘못돼 있었나** — [nginx.conf](../apis/mono/deploy/nginx.conf) 는 단순 `proxy_pass` 만 있고 `keepalive`, `proxy_next_upstream` 등 resilience 디렉티브가 없었다. 단일 upstream TCP reset 이 곧바로 502 HTML 페이지로 응답됐다.

**드러난 방식** — showtime-overlap-race 에서 iter 24/30 까지 정상이다가 iter 25 에서 응답이 `<html><head><title>502 Bad Gateway>...` 로 시작. 테스트의 `JSON.parse(raw)` 가 크래시. nginx 로그엔 `recv() failed (104: Connection reset by peer) while reading response header from upstream` 이 찍혀 있었다.

**조치** — `keepalive 32`, `proxy_next_upstream error timeout http_502 http_503 http_504`, `proxy_next_upstream_tries 3`, `_timeout 10s` 를 추가했다 ([a40ea55](https://github.com/mannercode/nest-seed/commit/a40ea55)). POST 는 기본적으로 재시도하지 않으므로 안전하고, GET/SSE 는 다른 replica 로 재시도된다.

---

## 5. bcrypt 가 Node 기본 libuv threadpool(=4) 을 포화시켰다

**무엇이 잘못돼 있었나** — 컨테이너 환경변수에 `UV_THREADPOOL_SIZE` 가 없어 기본 4 스레드로 돌았다. bcrypt 10-round hash 는 CPU-bound 로 libuv 에서 돈다. POST /customers / POST /customers/login 이 bcrypt 를 태우는데, 500 concurrent 요청이 들어오면 4 스레드에 125 개씩 쌓여 대기 4~5 초 걸린다.

**드러난 방식** — customer-race 가 5/6 회 PASS 한 뒤, 6번째 run iter 2 에서 1 × 502 가 떨어졌다. nginx 로그를 보면 POST /customers 가 모두 4.5~5.5 초 걸리고 있었고, CPU 경합으로 한 요청이 transient TCP 리셋으로 502 가 됐다.

**조치** — compose env 에 `UV_THREADPOOL_SIZE=16` 을 박았다 ([6f17aed](https://github.com/mannercode/nest-seed/commit/6f17aed)). bcrypt 처리량이 4배로 늘어 큐 대기가 사라졌다. Dockerfile 은 건드리지 않고 compose 쪽에서만 조정.

---

## 6. 테스트 부팅 스크립트가 Docker Hub rate limit 에 대응이 없었다

**무엇이 잘못돼 있었나** — [runner.sh](../apis/mono/tests/runner.sh) 와 [bootup-test.sh](../.github/scripts/bootup-test.sh) 가 `docker compose up -d --build` 를 단발로 불렀다. Docker Hub 의 미인증 풀 제한(100/6h per IP)은 GitHub Actions runner 공유 IP pool 에서 금방 걸린다.

**드러난 방식** — scenario/bootup job 이 부팅 단계에서 `error from registry: You have reached your unauthenticated pull rate limit` 로 실패했다. nginx:alpine, mongo, redis, minio, temporal/postgres 등 Docker Hub 이미지가 많아 한 job 이 실패하면 다른 job 도 비슷한 시점에 걸린다.

**조치** — compose up 을 5 회까지 10/20/30/40 초 백오프로 재시도하는 함수로 감쌌다 ([5ac21ba](https://github.com/mannercode/nest-seed/commit/5ac21ba), [89326e3](https://github.com/mannercode/nest-seed/commit/89326e3)). 더 근본적인 해결은 이미지를 GHCR 로 미러링하거나 Docker Hub 인증을 거는 것이지만, 그건 별도 결정 필요.

---

## 7. unit matrix 가 공용 infra 를 날려버리고 있었다

**무엇이 잘못돼 있었나** — test-stability matrix 를 리팩터하면서 libs 전용이던 `docker rm -f $(docker ps -aq)` 구문이 모든 scope 에 적용됐다. libs 는 testcontainers 를 써서 공용 infra 와 독립이지만 apis/mono·apis/msa 의 unit 테스트는 devcontainer 의 공용 mongo/redis/minio 를 재사용한다.

**드러난 방식** — apis/msa unit 에서 MinIO `ECONNREFUSED` 로 테스트가 실패. docker ps 를 보니 MinIO 컨테이너가 matrix 의 teardown 단계에 삭제돼 있었다.

**조치** — 공용 infra 를 건드리는 `docker rm` 단계를 libs scope 에서만 실행되도록 되돌렸다 ([5e350d9](https://github.com/mannercode/nest-seed/commit/5e350d9)).

---

## 8. CI 빌드 단계의 `npm install` 이 네트워크 flake 에 무방비

**무엇이 잘못돼 있었나** — [apis/mono/deploy/test.sh](../apis/mono/deploy/test.sh), [apis/msa/deploy/test.sh](../apis/msa/deploy/test.sh) 가 `docker compose up -d --build` 를 단발로 호출. Docker build 안의 `RUN npm install` 이 registry.npmjs.org 에 `ECONNRESET` 을 받으면 그대로 빌드 실패 → atoz 실패.

**드러난 방식** — scenario 강도를 올린 push 에서 CI 가 MSA atoz 의 `#17 [applications build 9/17] RUN npm install` 에서 `npm error code ECONNRESET / network read ECONNRESET` 로 실패. 전부 일시적 transport 오류.

**조치** — test.sh 의 compose up 을 5 회 10/20/30/40 초 백오프 재시도로 감쌌다 ([1ba6764](https://github.com/mannercode/nest-seed/commit/1ba6764)). 더 근본적으로는 pre-built base image 를 GHCR/ECR 에 두고 `npm install` 자체를 CI 경로에서 제거하는 방향.

---

## 9. Node HTTP `keepAliveTimeout` 이 nginx upstream keepalive pool 보다 짧았다

**무엇이 잘못돼 있었나** — nginx.conf 에 `keepalive 32` 를 추가한 반면 Node HTTP server 의 `keepAliveTimeout` 은 기본 5 초. nginx 기본 upstream `keepalive_timeout` 은 60 초. 차이가 생기는 구간에서 nginx 가 유지 중이라 믿은 idle connection 을 Node 가 먼저 닫아버리고, 그 뒤 nginx 가 그 connection 을 재사용하면 `recv() failed (104: Connection reset by peer)` → 502.

**드러난 방식** — INNER_ITERATIONS 를 30 → 500 으로 올린 뒤 showtime-overlap-race 가 iter 358/500 에서 1 회 502 를 받아 `<html>` 응답으로 `JSON.parse` 크래시. nginx 로그에 위 메시지. POST 는 `proxy_next_upstream` 기본값에서 재시도되지 않아 그대로 클라이언트로 전파. 저확률 이슈라 INNER 30 에서는 숨었다가 500 으로 올리니 사실상 매 run 노출.

**조치** — [configure-app.ts](../apis/mono/src/config/configure-app.ts) 에서 `app.listen()` 반환 server 의 `keepAliveTimeout = 65_000`, `headersTimeout = 66_000` 으로 맞췄다 (업계 표준: upstream 쪽 타임아웃보다 크게). MSA 도 동일하게 적용 ([1ae8a91](https://github.com/mannercode/nest-seed/commit/1ae8a91)).

---

## 검증 결과

위 조치를 모두 누적한 run 24711564026 에서 10 job (5 scenario + 3 unit + 2 bootup) 전부 PASS. 재현성을 확인하는 추가 run 진행 중.

> **주의** — 이 문서는 "부하를 걸고 관측된 실패" 만 다룬다. 시나리오 구현·동작 자체에 대한 설명은 [testing.md §9](./testing.md#9-분산-테스트) 로.
