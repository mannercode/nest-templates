# 기술 스택

본 시드의 기술 선택 현황과 검토 결과를 정리한다. 개별 결정의 상세 근거는 [decisions.md](decisions.md) 참조.

---

## 1. 채택 (이미 적용)

| 분야                   | 기술                                                     |
| ---------------------- | -------------------------------------------------------- |
| 프레임워크             | NestJS                                                   |
| 메시징 (msa)           | NATS                                                     |
| 메시징 (mono)          | Redis Pub/Sub (`PubSubService`, cross-replica SSE)       |
| 분산 락 (mono)         | Redis SET NX + Lua (`cache.withLock` / `withLockBlocking`) |
| 워크플로우             | Temporal (msa) / BullMQ (mono)                           |
| DB                     | MongoDB (replica set)                                    |
| 캐시/큐                | Redis (cluster)                                          |
| 객체 스토리지          | S3 / MinIO                                               |
| 컨테이너               | Docker, Docker Compose                                   |
| CI                     | GitHub Actions                                           |
| 테스트 (단위/통합)     | Jest + Testcontainers                                    |
| 테스트 (e2e)           | bash + curl spec                                         |
| 테스트 (분산 stress)   | Node 블랙박스 + 4-replica docker compose                 |

---

## 2. 대중성 기준 우선순위

운영 환경에서 얼마나 자주 보이는지를 기준으로 분류한다. 본 시드 적용 여부와는 별개의 축이다.

### Tier 1 — 거의 모든 운영 환경에서 봄 (선택의 여지 없는 표준)

| 순위 | 기술                           | 본 시드 상태        |
| ---- | ------------------------------ | ------------------- |
| 1    | **Docker**                     | ✅ 적용             |
| 2    | **Kubernetes**                 | ❌ 미적용 (compose) |
| 3    | **Prometheus + Grafana**       | ❌ 미적용           |
| 4    | **OpenTelemetry**              | ❌ 미적용           |
| 5    | **GitHub Actions / GitLab CI** | ✅ 적용             |
| 6    | **Helm**                       | ❌ 미적용 (K8s 짝)  |

> docker-compose는 dev/초기 단계용. 운영은 K8s가 사실상 표준 (관리형 EKS/GKE/AKS 포함)

### Tier 2 — 대중적, 운영에서 자주 봄

| 순위 | 기술                               | 비고                                |
| ---- | ---------------------------------- | ----------------------------------- |
| 7    | **Kong / NGINX Ingress / Traefik** | API Gateway / Ingress               |
| 8    | **ELK 또는 Loki**                  | 로그 집계 (ELK 대중적, Loki 가벼움) |
| 9    | **Jaeger 또는 Tempo**              | 분산 트레이싱                       |
| 10   | **Terraform**                      | IaC 표준                            |
| 11   | **Argo CD**                        | GitOps (K8s 환경)                   |
| 12   | **Vault 또는 클라우드 KMS**        | 시크릿                              |

### Tier 3 — 큰 조직 / 특정 요구

| 순위 | 기술                    | 사용처                     |
| ---- | ----------------------- | -------------------------- |
| 13   | **Keycloak**            | 자체 SSO/OIDC              |
| 14   | **Datadog / New Relic** | SaaS 관측성 (대규모 운영)  |
| 15   | **Istio**               | 서비스 메시 (mTLS, 트래픽) |
| 16   | **Backstage**           | 개발자 포털                |

### Tier 4 — 알면 좋음

Pact (계약 테스트), k6 (부하 테스트), Trivy (이미지 스캔), Cosign (이미지 서명), Harbor (사설 레지스트리), Chaos Mesh (카오스 엔지니어링)

---

## 3. 본 시드에 적용할 우선순위

대중성 + 시드 가치(코드 부담, 즉시 효용)를 함께 고려한 적용 순서.

| 순서 | 작업                                              | 이유                                    |
| ---- | ------------------------------------------------- | --------------------------------------- |
| 1    | **OpenTelemetry 계측**                            | Tier 1, 코드 부담 적음, 즉시 가치       |
| 2    | **Prometheus `/metrics` 엔드포인트**              | Tier 1, `nestjs-prometheus`로 간단 추가 |
| 3    | **Kubernetes manifests + Helm chart** (`deploy/`) | Tier 1, 운영 참조 구현                  |
| 4    | **Ingress 예시** (NGINX Ingress 또는 Kong)        | Tier 2, K8s 진입점                      |
| 5    | **Trivy CI 단계**                                 | Tier 4지만 가벼움, 보안 이득            |

---

## 4. 명시적 거부 (근거 기록)

| 기술                             | 거부 사유                                                                                                                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Kafka**                        | NATS 선택. kafkajs 유지보수 종료(2022), maxWaitTimeInMs 폴링으로 테스트 종료 느림, 토픽 사전 생성 비용, broker3+controller3 메모리 부담 (자세한 근거: [decisions.md](decisions.md) 1번)      |
| **OpenAPI / Swagger**            | bash + curl 기반 e2e shell spec(`apis/{mono,msa}/tests/e2e/specs/*.spec`)으로 대체. 코드 동기화 비용 없음, 실행 가능한 살아있는 문서, 시나리오 흐름 표현, CI 통합 용이, 데코레이터 부담 없음 |
| **BFF Gateway**                  | mono와 중복. 외부 라우팅/인증은 인프라 게이트웨이로 위임 (TODO.md `msa/gateway 제거 검토` 항목 참조)                                                                                         |
| **Service Mesh (Istio/Linkerd)** | 시드 복잡도 초과. K8s 운영 단계에서 별도 검토                                                                                                                                                |
| **Datadog / New Relic**          | SaaS 의존, OSS 시드에 부적합. 운영자가 선택                                                                                                                                                  |
| **Consul / Eureka**              | K8s 환경에서는 기본 DNS/Service로 해결                                                                                                                                                       |
