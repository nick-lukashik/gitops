# platform

App-of-apps: `kustomization.yaml` lists the Applications, `root` syncs them. The order comes from `argocd.argoproj.io/sync-wave`.

| Folder | Application | What |
|---|---|---|
| `argocd/` | `argocd`, `projects`, ApplicationSet `apps-prod` | Argo CD (manages itself, without self-heal), notifications, AppProjects, the services |
| `sealed-secrets/` | `sealed-secrets` | the controller, its own key, rotation off |
| `policies/` | `policies` | namespaces with Pod Security, PriorityClasses, quotas of `prod`; NetworkPolicies: `prod` default deny both ways and `api-clients`, default deny ingress of `monitoring` and `monitoring-node` |
| `cert-manager/` | `cert-manager` | chart, ClusterIssuer Let's Encrypt (production), DNS-01 with Cloudflare |
| `traefik-config/` | `traefik-config` | HelmChartConfig of the bundled Traefik (the plugin and the shared middlewares `real-ip`, `body-limit`, `ops-strip-identity`, `ops-auth` in the file provider), TLSStore, TLSOption with Origin Pulls, the wildcard certificate |
| `monitoring/kube-prometheus-stack/` | `kube-prometheus-stack` | Prometheus, Alertmanager (Telegram, Healthchecks), node-exporter; ingress allow-lists of `monitoring` (`from-prometheus`, `prometheus`, `alertmanager`) |
| `monitoring/rules/` | `monitoring-rules` | platform alerts and their unit tests |
| `monitoring/loki/` | `loki` | Loki 3.7 single binary, chunks and index in R2 `nl-loki`, 30 days; its R2 key and ingress allow-list (Alloy, Grafana) |
| `monitoring/alloy/` | `alloy` | pod logs and journald, secret masking; ingress only from Prometheus |
| `monitoring/grafana/` | `grafana` | Grafana, datasources, auth proxy; ingress only from Traefik |

`admin-route/` in `argocd/` and `monitoring/grafana/`: admin routes, off until E4; CI builds them.
