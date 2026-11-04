# Node resources and Pod Security

The node: 15 GiB of memory, 300 GB of disk. The kubelet reserves 1 GiB for the system and 1 GiB for K3s, and keeps 0.5 GiB free before evicting (`infra/node/k3s/config.yaml`). About 12.5 GiB are left for pods.

## Memory budget

Request and limit of memory from the values in `platform/`. Short Jobs (`startupapicheck`, `redis-secret-init`, migrations) are not counted.

| Component | Namespace | Request | Limit |
|---|---|---|---|
| Argo CD: controller 512/1024, repo-server 256/512, server 128/256, applicationset 64/128, notifications 64/128, redis 64/128 | `argocd` | 1088 MiB | 2176 MiB |
| Sealed Secrets | `kube-system` | 64 MiB | 128 MiB |
| cert-manager: controller 96/256, webhook 32/96, cainjector 64/192 | `cert-manager` | 192 MiB | 544 MiB |
| Traefik (HelmChartConfig) | `kube-system` | 128 MiB | 256 MiB |
| Prometheus 1024/2048 + config-reloader 32/64 | `monitoring` | 1056 MiB | 2112 MiB |
| Alertmanager 64/128 + config-reloader 32/64 | `monitoring` | 96 MiB | 192 MiB |
| Prometheus Operator 64/192, kube-state-metrics 64/128 | `monitoring` | 128 MiB | 320 MiB |
| node-exporter | `monitoring-node` | 32 MiB | 64 MiB |
| Loki | `monitoring` | 512 MiB | 1024 MiB |
| Alloy 128/512 + config-reloader 32/64 | `monitoring-node` | 160 MiB | 576 MiB |
| Grafana | `monitoring` | 256 MiB | 512 MiB |
| K3s: CoreDNS, metrics-server, local-path, svclb (estimate) | `kube-system` | 200 MiB | 300 MiB |
| **Platform, total** | | **≈ 3.8 GiB** | **≈ 8.0 GiB** |
| Services: ResourceQuota `memory` | `prod` | 4 GiB | 8 GiB |
| **All** | | **≈ 7.8 GiB (63%)** | **≈ 16.0 GiB (128%)** |

- The requests fit with room to spare. The limits exceed the node memory by a quarter: not all components reach their limit at once, and under pressure the kubelet evicts pods of lower priority first (`batch`, then `service`).
- Every service runs at least two replicas (HorizontalPodAutoscaler 2 to 4 on CPU, `components/service`), so a service costs twice its pod in the `prod` quota and more while it is scaled out. When the quota is full, the autoscaler cannot add pods: that is the cap, and the quota grows in a PR when it is reached.
- A container in `prod` without its own resources gets a 128 MiB request and a 256 MiB limit (LimitRange `defaults`). Services set their own in the components: web 128 MiB request / 384 MiB limit, api 192 MiB / 512 MiB, the api migrate Job 128 MiB / 512 MiB; a CPU request only, no CPU limit ([components/README.md](../components/README.md)).
- Stage `E3-core` adds Postgres (CNPG), RabbitMQ and Redis, roughly another 2–3.5 GiB of requests. Before it, review the `prod` quota and the Prometheus limits.

## Disk

One disk holds etcd, the container images, the container logs and every volume. `local-path` volumes do not enforce their size, so nothing that grows with traffic is stored there without its own bound.

| Data | Where | Bound |
|---|---|---|
| Prometheus TSDB | `local-path` volume 15 GiB | 7 days and at most 13 GB (`retentionSize`, enforced by Prometheus) |
| Loki chunks and index | R2 bucket `nl-loki` | 30 days (`retention_period: 720h`, compactor), R2 lifecycle after 31 days; ingestion rate limits |
| Loki WAL, index being built, index cache | `emptyDir` | `sizeLimit: 5Gi`, enforced by the kubelet (the pod is evicted, the logs in R2 stay) |
| Alertmanager | `local-path` volume 1 GiB | silences and notification state, small |
| Grafana | `local-path` volume 1 GiB | the Grafana database, small |
| Container logs | `/var/log/pods` | kubelet rotation, 10 MiB × 5 files per container (defaults) |
| `emptyDir` of services | node disk | `/tmp` 64 MiB, `/app/.next/cache` 512 MiB (`sizeLimit`) |

Protection of the disk (and of etcd on it):

- the kubelet evicts pods at `nodefs.available<10%` and `imagefs.available<15%` (`eviction-hard` in `infra/node/k3s/config.yaml`; set explicitly, since setting it drops the defaults) and garbage-collects images;
- alerts: `NodeDiskUsageHigh` (80%), `NodeDiskUsageCritical` (90%), `NodeDiskFillingUp` (at the growth rate of the last hour the eviction threshold is reached within 6 hours; fires while there is still room) in `platform/monitoring/rules/node.yaml`, and the default `NodeFilesystemSpaceFillingUp` of kube-prometheus-stack.

## Priorities

| PriorityClass | Value | Who |
|---|---|---|
| `platform-critical` | 100000 | Argo CD, Sealed Secrets, cert-manager, monitoring; at stage 3 also CNPG and RabbitMQ |
| `service` | 1000, `globalDefault` | services of `prod` and everything without a class |
| `batch` | 100, never preempts others | drills, one-off Jobs |

Traefik, CoreDNS and metrics-server keep `system-cluster-critical` from K3s.

## Pod Security Admission

| Namespace | Level | Why |
|---|---|---|
| `prod` | `restricted` | services are built from `components/service` (+ `api` or `web`), which passes `restricted` |
| `argocd` | `restricted` | every pod of the chart passes |
| `cert-manager` | `restricted` | every pod of the chart passes |
| `monitoring` | `restricted` | Prometheus, Alertmanager, Grafana, Loki, operator, kube-state-metrics; the root init container of Grafana is off |
| `traefik` | `restricted` | no pods: TLSStore, TLSOption, Certificate and the Origin Pulls CA |
| `monitoring-node` | `privileged` | node-exporter: `hostNetwork`, `hostPID`, hostPath `/`; Alloy: hostPath of the journal and positions. `baseline` forbids all of that, hence `privileged`, not `baseline` |
| `kube-system` | no labels (K3s: `privileged`) | Traefik, svclb (`NET_ADMIN`), local-path helper pods (hostPath), Sealed Secrets. The namespace belongs to K3s |

## Network policies

Default deny in `prod` (both ways), `monitoring` and `monitoring-node` (ingress), allow-lists per component: [README.md](../README.md#network).
