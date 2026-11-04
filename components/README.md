# components

Kustomize components. They are never built on their own, only as part of `apps/` and `platform/`.

| Component | What |
|---|---|
| `settings/` | `settings.yaml`: domain and Telegram ids; the source for replacements and for the values of Helm applications |
| `host/` | puts the domain into the IngressRoute of the build (annotation `nl-gitops/host` and `Host()`) |
| `subdomain/` | prefixes the host with ConfigMap `route` `.data.subdomain` |
| `service/` | common part of every service, see below |
| `api/` | api kind (NestJS), after `service` |
| `web/` | web kind (Next.js), after `service` |
| `internal/` | after `api` instead of a host: no IngressRoute, no ingress from Traefik. For an api only the platform's pods call (the account services) |

## Services

`service`, `api` and `web` implement the [service runtime contract](https://github.com/nick-lukashik/.github/blob/master/docs/service-contract.md). A service folder includes `service` first, then exactly one of `api` or `web`, then optionally `subdomain` ([apps/README.md](../apps/README.md)). `make verify` enforces this (`scripts/check-apps.sh`).

The name comes from ConfigMap `service` `.data.name` (local config of the service folder). The image is `ghcr.io/nick-lukashik/<name>`; its digest is the `images:` entry of the service folder.

| | `service` (both kinds) | `api` adds | `web` adds |
|---|---|---|---|
| Workload | Deployment `<name>`: 2 to 4 replicas (HorizontalPodAutoscaler on CPU, 75% of the request), surge 1 / unavailable 0, PodDisruptionBudget `maxUnavailable: 1` | Job `<name>-migrate`: `node dist/db/migrate.js`, same image, config and secrets | |
| Ports | `http` 3000 (env `PORT=3000`); Service port 80 | `metrics` 9464 (env `METRICS_PORT=9464`) on the pod and the Service | |
| Probes | startup `/health/live` (every 2 s, up to 2 min), liveness `/health/live`, readiness `/health/ready` | | |
| Security | uid/gid/fsGroup 10001, non-root, `seccompProfile: RuntimeDefault`, drop `ALL`, no privilege escalation, read-only root filesystem, no ServiceAccount token, `priorityClassName: service` | | |
| Filesystem | `/tmp` `emptyDir` 64 MiB | | `/app/.next/cache` `emptyDir` 512 MiB |
| Shutdown | `preStop` native `sleep` 5 s, `terminationGracePeriodSeconds: 30` | | |
| Resources | requests 50m / 128 MiB, limit 384 MiB, no CPU limit | requests 100m / 192 MiB, limit 512 MiB | the `service` defaults |
| Config | `envFrom`: ConfigMap `<name>-config` (required), Secret `<name>-secrets` (optional) | the Job reads the same | |
| Route | IngressRoute `<name>` on `websecure` with `real-ip@file`; `components/api` adds `body-limit@file` (request body at most 1 MiB, 413 above). Web routes enforce the limit in the app: Traefik buffering also buffers whole responses and would break streamed HTML; host in annotation `nl-gitops/host` | | |
| Labels | pod: `app.kubernetes.io/name: <name>`, `app.kubernetes.io/component: server` | + `nick-lukashik.com/kind: api` | + `nick-lukashik.com/kind: web`, `nick-lukashik.com/api-client: "true"` |
| Network in | NetworkPolicy `<name>`: Traefik on `http` | + pods labelled `api-client` in `prod` on `http`, Prometheus on `metrics` | |
| Network out | CoreDNS only (53 UDP/TCP) | + namespaces labelled `nick-lukashik.com/data: "true"` (stage 3), public addresses on 443 (private, CGNAT, link-local, loopback excluded); NetworkPolicy `<name>-migrate`: the Job gets CoreDNS and the data namespaces | api pods on `http`: NetworkPolicy `api-clients` of `platform/policies/prod.yaml` selects the `api-client` label |
| Metrics | | ServiceMonitor `<name>` on `metrics`, `/metrics` | none (Traefik has the HTTP metrics) |

`prod` denies ingress and egress by default (`platform/policies/prod.yaml`), so a service gets exactly the rows above. The `api-client` label is one switch for both directions of a call to an api: the api accepts it, and `api-clients` lets it out. An api that calls another api adds the label in its own folder ([apps/README.md](../apps/README.md)). `make verify` checks the egress rules of every build (`scripts/check-netpol.sh`).

No CPU limit: a CFS quota throttles the Node.js event loop during bursts (slow responses, failed probes) even when the node has idle cores. The CPU request gives each pod its share under contention; the memory limit is what protects the node.

### Sync order (Argo CD waves)

| Wave | What |
|---|---|
| -1 | SealedSecret `<name>-secrets` (Argo CD waits until the Secret is decrypted) |
| 0 | ConfigMap `<name>-config-<hash>`, Service, IngressRoute, NetworkPolicies, ServiceMonitor; the api migrate Job (Sync hook) runs and must succeed |
| 1 | Deployment |

The migrate Job is a `Sync` hook in wave 0, not `PreSync`: `PreSync` runs before the ConfigMap and the SealedSecret of the same sync exist (the first sync of a service, and every config change, since the ConfigMap name carries a content hash), so the Job could never start. The order above gives the same guarantee: the new version rolls out only after the migration succeeded. `PruneLast=true` (ApplicationSet `apps-prod`) keeps the old ConfigMap until the new pods run.
