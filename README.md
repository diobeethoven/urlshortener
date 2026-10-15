# URL Shortening Service - Architecture and Design

## Overview

This is a large-scale URL shortening service designed to handle **100,000 redirects per second** with **p99 latency under 50ms** and high availability against single-node failure. The system leverages a modern microservices architecture with Go, PostgreSQL, Redis, NATS JetStream, ClickHouse, and Docker/Kubernetes for deployment.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLIENT LAYER                             │
│  ┌─────────────┐  HTTPS  ┌─────────────────────┐  HTTP/HTTPS  │
│  │  Web Browser│  ──────▶ │  Envoy Load Balancer│ ──────▶       │
│  └─────────────┘         └─────────────────────┘              │
│          │                                              │
│          ▼                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                    ENVY LAYER                             │ │
│  │  • TLS Termination                                       │ │
│  │  • Rate Limiting (Token Bucket)                          │ │
│  │  • Request Coalescing (Singleflight)                     │ │
│  │  • Health Checks                                         │ │
│  │  • Circuit Breakers                                      │ │
│  └─────────────────────────────────────────────────────────┘ │
│          │                                              │
│          ▼                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                    API GATELAYER                          │ │
│  │  • Go Microservice (12-factor)                           │ │
│  │  • JWT Authentication                                    │ │
│  │  • Malicious URL Detection                               │ │
│  │  • Idempotency Keys                                      │ │
│  └─────────────────────────────────────────────────────────┘ │
│          │                                              │
│          ▼                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                    SERVICE LAYER                          │ │
│  │  • URL Shortening Service                                │ │
│  │  • Code Generation (Redis INCR)                          │ │
│  │  • Custom Alias Support                                  │ │
│  │  • Request Coalescing                                    │ │
│  └─────────────────────────────────────────────────────────┘ │
│          │                                              │
│          ▼                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                    CACHING LAYER                          │ │
│  │  • In-memory LRU (Go)                                    │ │
│  │  • Redis Cluster (distributed)                           │ │
│  │  • CDN Edge Caching                                      │ │
│  │  • Negative Caching (404s)                               │ │
│  └─────────────────────────────────────────────────────────┘ │
│          │                                              │
│          ▼                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                    DATA LAYER                             │ │
│  │  • PostgreSQL (primary)                                  │ │
│  │  • PgBouncer (connection pooling)                        │ │
│  │  • Read Replicas (scaling)                               │ │
│  │  • Consistent Hash Sharding                              │ │
│  │  • ClickHouse (analytics)                                │ │
│  └─────────────────────────────────────────────────────────┘ │
│          │                                              │
│          ▼                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                    MESSAGING LAYER                        │ │
│  │  • NATS JetStream                                        │ │
│  │  • Async Click Logging                                   │ │
│  │  • Durable Subscriptions                                 │ │
│  └─────────────────────────────────────────────────────────┘ │
│          │                                              │
│          ▼                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                    ANALYTICS LAYER                        │ │
│  │  • ClickHouse                                            │ │
│  │  • Pre-aggregated Statistics                             │ │
│  │  • Real-time Dashboards (React)                          │ │
│  │  • JWT Authentication                                    │ │
│  │  • Malicious URL Detection                               │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## Key Design Decisions

### 1. **Distributed Unique Code Generation (Redis INCR)**
- Uses Redis's atomic `INCR` command to generate unique base62 codes
- Prevents collisions across multiple service instances
- Counter key: `urlshort:counter`
- Base62 encoding: `0-9A-Za-z` (62 characters)
- Short codes are 7 characters long, supporting ~3.5 trillion unique URLs

### 2. **Multi-Layer Caching Strategy**
- **LRU Cache**: Go's `sync.Map`-based in-memory cache (fastest, ~100ns)
- **Redis Cache**: Distributed cache with TTL (24h), handles cache misses
- **Negative Caching**: Codes that don't exist are cached with `null` value (5min TTL)
- **CDN Edge Caching**: Static short URL redirects cached at edge locations

### 3. **Request Coalescing (Singleflight)**
- Prevents "thundering herd" when cache misses occur
- Multiple concurrent requests for the same code trigger only one DB query
- Subsequent requests wait for the result and receive the same response

### 4. **Asynchronous Click Logging (NATS JetStream)**
- Clicks are published to NATS JetStream immediately (sub-microsecond)
- Separate consumers write to ClickHouse in batch
- Does not impact redirect latency
- Provides exactly-once semantics with streaming

### 5. **Database Scaling Strategy**
- **Primary**: PostgreSQL with PgBouncer for connection pooling
- **Read Replicas**: Asynchronous replication for read-heavy workloads
- **Consistent Hash Sharding**: URLs sharded across PostgreSQL instances based on hash(short_code) % N
- **Failover**: Patroni for PostgreSQL automatic failover

### 6. **Rate Limiting (Redis Token Bucket)**
- Token bucket algorithm stored in Redis
- Global rate limit: 100 requests/sec per IP
- Per-endpoint limits: `/api/shorten` stricter than `GET /{code}`
- 429 responses with `Retry-After` header

### 7. **Circuit Breakers**
- Hystrix-style circuit breakers around database operations
- Opens after 5 consecutive failures
- Half-open state after 30s timeout
- Prevents cascading failures

### 8. **Idempotency**
- `Idempotency-Key` header support for `/api/shorten`
- Same key returns same short code
- Prevents duplicate URL creation on retries

### 9. **Malicious URL Detection**
- URL validation with allowlist/blocklist
- Domain reputation service integration
- Safe browsing API check
- Sandbox preview generation

### 10. **Custom Alias Support**
- Users can specify custom short codes
- Validation: alphanumeric, max 32 characters
- Uniqueness check before assignment
- Premium feature with rate limits

## Infrastructure Components

### Docker Services
- **PostgreSQL 15**: Primary data store
- **Redis 7**: Caching and counter service
- **NATS 2**: Async messaging with JetStream
- **ClickHouse 24.3**: Analytics database
- **PgBouncer**: Connection pooler
- **Envoy**: Layer 7 load balancer
- **Prometheus**: Metrics scraping
- **Grafana**: Dashboards and alerting

### Kubernetes Deployment
- 3 replicas for each critical service
- Health checks and auto-restart policies
- Horizontal Pod Autoscaler (HPA)
- Network policies for security
- Persistent volumes for data durability

## Monitoring & Observability

### OpenTelemetry
- Automatic instrumentation for Go HTTP services
- Custom metrics for redirect latency, cache hit rate
- Trace propagation through NATS and ClickHouse
- Exporters to Prometheus and Jaeger

### Prometheus Metrics
- `redirect_latency_seconds` - histogram (p50, p95, p99)
- `redirects_total` - counter by status code
- `cache_hit_ratio` - in-memory/Redis/CDN
- `database_query_duration` - query timing
- `nats_messages_published` - click event rate
- `rate_limiter_tokens_consumed` - rate limiting

### Grafana Dashboards
- Real-time redirect latency heatmap
- Traffic sources and geographic distribution
- Cache hit/miss ratios
- Database connection pool usage
- Rate limit alerts
- Click analytics trends

## Load Testing Strategy

### k6 Test Scenarios

1. **Baseline Load**: 100-1000 RPS with p99 < 50ms target
2. **Viral Link Scenario**: One link shared massively, spike traffic
3. **Chaos Testing**:
   - Shutdown Redis shard - verify graceful degradation
   - Shutdown PostgreSQL replica - verify read replica failover
   - Restart NATS - verify message durability
   - 50% service instance termination - verify HA

### Expected Results
- **100k RPS**: All targets met with p99 < 50ms
- **Viral link**: System handles 5x traffic spike gracefully
- **Redis failure**: 80% of traffic served from LRU cache + read replicas
- **Database failover**: < 5s switchover time

## Deployment

### Prerequisites
- Docker Desktop / Docker Engine
- Kubernetes cluster (EKS, GKE, or Kind)
- Terraform 1.5+
- GitHub Actions secrets configured

### Local Development
```bash
# Start infrastructure
docker-compose up -d

# Run migrations
go run cmd/main.go --migrate

# Start the service
go run cmd/main.go
```

### Production Deployment
```bash
# Apply Terraform
terraform init
terraform apply

# Deploy application
kubectl apply -f k8s/

# Access the service
# Ingress: short.url/api/shorten
# Health: curl http://short.url/health
```

### GitHub Actions CI/CD
- **build-and-test**: Go vet, tests, dependency check
- **build-docker**: Build and push to Docker Hub
- **deploy**: Kubernetes rollout
- **load-test**: k6 performance testing

## Resilience Against Single-Node Failure

| Failure Scenario | Mitigation Strategy |
|-----------------|---------------------|
| Single Redis node | 3-node cluster with Sentinel failover |
| Single PostgreSQL node | Patroni automatic failover + read replicas |
| Single NATS node | Cluster mode with replication |
| Single ClickHouse node | ClickHouse Keeper + Zookeeper |
| Service instance failure | K8s auto-restart + HPA scaling |
| Network partition | Circuit breakers + graceful degradation |
| CDN edge node failure | Anycast routing + failover |

## Performance Targets

| Metric | Target |
|--------|--------|
| **RPS** | 100,000 |
| **p50 Latency** | < 20ms |
| **p99 Latency** | < 50ms |
| **Error Rate** | < 0.1% |
| **Availability** | 99.99% |
| **Cache Hit Ratio** | > 95% |
| **Database Write Latency** | < 5ms |