# gitops

Everything that runs in the nick-lukashik cluster: single-node K3s, Argo CD 3.x keeps the cluster in line with this repo. Secrets are SealedSecrets only ([SECRETS.md](SECRETS.md)).

## Layout

| Folder | What |
|---|---|
| [`bootstrap/`](bootstrap/) | installed once: Sealed Secrets key and controller, Argo CD, repo access, `root` |
| [`platform/`](platform/) | app-of-apps: Argo CD, Sealed Secrets, cert-manager, Traefik, policies, monitoring |
| [`apps/<service>/prod/`](apps/) | one folder per service; each becomes Application `<service>-prod` (ApplicationSet `apps-prod`). Templates: `apps/_example-web`, `apps/_example-api` |
| [`components/`](components/) | kustomize components: `service` + `api` or `web` (the service runtime contract), settings, host |
| [`projects/`](projects/) | AppProjects `platform` and `prod` |
| [`docs/`](docs/) | resource budget, runbooks |
| [`scripts/`](scripts/) | the `make verify` checks |

Services follow the [service runtime contract](https://github.com/nick-lukashik/.github/blob/master/docs/service-contract.md): port `http` 3000, uid 10001, probes `/health/live` and `/health/ready`, config from ConfigMap `<service>-config`, secrets from SealedSecret `<service>-secrets`, api metrics on 9464 and migrations before the rollout. How a service folder looks: [apps/README.md](apps/README.md).

## One place for every value

| What | Where |
|---|---|
| Domain, Telegram group and topic ids | `components/settings/settings.yaml` |
| Helm chart versions | `targetRevision` in `platform/**/application.yaml`; `bootstrap/install.sh` reads them from there |
| Service images | `images` entry with a digest in `apps/<service>/prod/kustomization.yaml` |
| Service host | ConfigMap `route` (subdomain) in `apps/<service>/prod/service.yaml`; the root domain without it |
| Traefik values | `platform/traefik-config/helmchartconfig.yaml` |
| Repo access | none: Argo CD reads the public repo over HTTPS (`repoURL` in `platform/**/application.yaml`) |
| Versions of the check tools | `scripts/lib.sh` |

## Public repository

`gitops` is public: on GitHub Free only public repos get the `master` ruleset, and a merge to `master` here is a deploy. The ruleset (`infra` `docs/github.md`) requires a PR with one approval and the check `ci / verify`, and no bot or GitHub App may bypass it. The deployer App can open deploy PRs but cannot change `master`.

Everything here is readable by anyone. What may be in the repo:

- SealedSecrets only. A sealed value is safe in public as long as the Sealed Secrets key stays in Bitwarden. Never a `kind: Secret` with data, a token, a password, a key or a kubeconfig, also not in an example, a test fixture or a commit that is reverted later: history is public too.
- No addresses or identifiers of our accounts: no server IP, Tailscale name or IP, email address, Cloudflare account ID (the R2 endpoint contains it, so it is sealed in `loki-r2`). Public defaults (the K3s cluster ranges, the Cloudflare ranges) are fine.
- Comments and docs explain the design, not where to attack: no secret values, no "temporary" credentials, no notes about unpatched weaknesses. Those go to the private backlog.
- The domain is public anyway, but manifests take it only from `components/settings/settings.yaml` (`make verify` checks the YAML).

`make verify` catches plain Secrets and the domain outside its file; the rest is the reviewer's job on every PR.

## Checks

```sh
make verify
```

Only Docker is needed: the tools run in containers pinned by digest. CI runs on every PR (`.github/workflows/ci.yml` calls `verify.yml`, check `ci / verify`, required by the `master` ruleset). A PR that changes only `*.md` files gets the cheap checks (`make static`) instead of being skipped, so the required check always reports. The checks:

- no `kind: Secret` with data in git;
- the domain only in `components/settings/settings.yaml`;
- every Argo CD Application goes to a server and namespace of its AppProject (`scripts/check-destinations.sh`), otherwise Argo CD refuses it;
- `shellcheck` and `actionlint`;
- `kustomize build` of every folder with a `kustomization.yaml`, the service templates `apps/_example-web` and `apps/_example-api` included;
- `helm template` of every Helm application with its values, and of the Traefik bundled with K3s with the `HelmChartConfig`;
- images in `apps/*/prod` only by digest;
- every `apps/*/prod` follows the service contract (`scripts/check-apps.sh`): `components/service` first, then exactly one of `api` or `web`, optionally `subdomain`; one `images` entry `ghcr.io/nick-lukashik/<service>` with a digest and no `newName`; the build has the Deployment, its ConfigMap `<service>-config`, a route with a host and the middleware `real-ip@file` (an api also `body-limit@file`, 1 MiB; a web limits bodies in the app), and the parts of its kind. Third-party apps (none today) are listed in the script and skipped;
- network isolation (`scripts/check-netpol.sh`): `prod` denies ingress and egress by default; every workload of every `apps/*/prod` is selected by a policy with egress rules, and no rule allows any destination; services have DNS egress, an api has public 443 without private ranges, a web has the `api-client` label; `monitoring` and `monitoring-node` deny ingress by default; Loki has a policy whose only peers are Alloy, Grafana and Loki;
- `kubeconform -strict` against the Kubernetes 1.36 schemas (native `preStop` `sleep` included) and the CRD schemas (Argo CD, Traefik, cert-manager, Sealed Secrets, Prometheus Operator, K3s);
- `promtool check rules` and unit tests of every alert;
- `amtool check-config` of the Alertmanager config;
- Alloy syntax and the secret-masking test on sample logs.

Single checks: `make render`, `make apps`, `make netpol`, `make rules`, `make alloy` and the other targets of the `Makefile`.

## Network

K3s enforces NetworkPolicies with its embedded kube-router. The rules, in `platform/policies/` and next to each component:

| Namespace | Default | Allowed |
|---|---|---|
| `prod` | deny ingress and egress | ingress: Traefik on `http`; api: pods labelled `api-client` on `http`, Prometheus on `metrics`. Egress: CoreDNS (53 UDP/TCP) for every service; web and other `api-client` pods: api pods on `http`; api: namespaces labelled `data=true` (stage 3) and public addresses on 443 (private, CGNAT, link-local, loopback excluded); the api migrate Job: CoreDNS and data namespaces |
| `monitoring` | deny ingress | Prometheus to every pod (scrapes, alerts to Alertmanager); Grafana to Prometheus (9090), Alertmanager (9093) and Loki (3100); Alloy to Loki (3100); Traefik to Grafana (3000) |
| `monitoring-node` | deny ingress | Prometheus to Alloy (12345). node-exporter runs with `hostNetwork`: no NetworkPolicy applies to it; `prod` pods cannot reach node ports because their egress is denied |

kube-router always allows traffic from the node itself (kubelet probes) and does not apply policies to `hostNetwork` pods. `kubectl port-forward` is not subject to policies.

## Recovery

RPO and RTO targets, what is lost on a rebuild and the restore of the whole cluster on a clean server: [`docs/recovery.md` of `infra`](https://github.com/nick-lukashik/infra/blob/master/docs/recovery.md) (private repo). In short: the cluster is rebuilt from this repo, the Sealed Secrets key in Bitwarden and, optionally, an etcd snapshot in R2; logs are in R2; the volumes of stage 1–2 hold only data that is rebuilt (metrics, Grafana DB, Alertmanager state).

## Step 4. Bootstrap of the cluster

Only for a new server. After a reboot nothing has to be entered: the Sealed Secrets key is in etcd.

Before the run:

1. K3s is installed, and `kubectl get nodes` from the Mac over Tailscale shows `Ready` (step 3 in `infra`).
2. The repo `nick-lukashik/gitops` exists on GitHub (public), and `master` holds this code without `apps/landing-web` (it comes in the last PR, with the digest of its first image, see below):

   ```sh
   git add -A && git reset -q apps/landing-web && git commit -m "chore: gitops structure"
   git push -u origin master
   ```

3. `bootstrap/sealed-secrets.crt` is the public certificate from Bitwarden `sealed-secrets-crt`, committed.
4. On the Mac: `kubectl`, `helm`, `openssl`, `bw`, `jq`; `infra` lies next to `gitops` (otherwise `INFRA_DIR=<path>`).

Run from the root of `gitops`:

```sh
export BW_SESSION="$(bw unlock --raw)"
bootstrap/install.sh
```

In order, the script installs: the PriorityClasses, the Sealed Secrets key (`sealed-secrets-key` + `sealed-secrets-crt`, label `active`), the Sealed Secrets controller, Argo CD, the AppProjects and Application `root`. Secrets go only to temporary files in `$TMPDIR/nl-secrets/` and are removed on exit. A re-run changes nothing: each step is skipped if its result already exists.

Check:

```sh
kubectl -n argocd get applications          # root: Synced
kubectl -n kube-system get secret -l sealedsecrets.bitnami.com/sealed-secrets-key=active
```

Sealing test on the Mac: section "Check" of [SECRETS.md](SECRETS.md). Then change the `admin` password and delete `argocd-initial-admin-secret`: [docs/runbook/access.md](docs/runbook/access.md).

Right after the bootstrap some applications are `Degraded` or `Progressing`: their secrets are not there yet. The PRs below fix that.

## After the bootstrap: order of the PRs

Every PR passes `make verify`. The merge to `master` is the rollout.

1. **Certificate.** Seal `cf-dns01-token` ([SECRETS.md](SECRETS.md), the token is checked at Cloudflare first), PR, merge. cert-manager has only the production issuer `letsencrypt`. After the merge:

   ```sh
   kubectl get certificate -A                                         # Ready=True
   openssl s_client -connect <tailscale-name>:443 -servername id.nick-lukashik.com </dev/null 2>/dev/null |
     openssl x509 -noout -issuer                                      # Let's Encrypt
   ```

   Without the Cloudflare client certificate the handshake ends right after the server certificate: the issuer is visible, the request does not get through. That is expected.

   Checks before the landing (no routes yet):

   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' https://nick-lukashik.com     # 404 from Traefik through Cloudflare
   openssl s_client -connect <tailscale-name>:443 -servername nick-lukashik.com </dev/null 2>&1 |
     grep -i -E 'alert|certificate required'                           # direct TLS without the Cloudflare certificate fails
   ```

2. **Logs in R2.** After `apply` of `infra` step 1 (bucket `nl-loki`) and the key `r2-loki` in Bitwarden: seal `loki-r2` ([SECRETS.md](SECRETS.md)), PR, merge. Until then Loki does not start (no endpoint), and the other applications are not affected.
3. **Telegram and Healthchecks.** Once the Telegram group and the Healthchecks check exist: write the group and topic ids from Bitwarden `ops-telegram-topics` into `components/settings/settings.yaml`; seal `ops-telegram`, `argocd-notifications-secret`, `hc-watchdog`, `grafana-admin`, `grafana-auth-proxy`. One PR, merge. Checks:

   - a test alert ([docs/runbook/access.md](docs/runbook/access.md)) arrives in "Alerts"; `hc-watchdog` in Healthchecks is green;
   - a sync failure reaches "Alerts" within 3 minutes (an application on a folder that does not exist, through a port-forward of Argo CD):

     ```sh
     argocd app create notify-test --project prod --repo https://github.com/nick-lukashik/gitops.git \
       --path apps/does-not-exist --dest-server https://kubernetes.default.svc --dest-namespace prod
     # wait for "Sync status unknown: notify-test" in the topic "Alerts", then:
     argocd app delete notify-test --yes
     ```

   - Loki keeps 30 days, in R2:

     ```sh
     kubectl -n monitoring port-forward svc/loki 3100 &
     curl -s localhost:3100/config | grep -E 'retention_(period|enabled)|object_store|bucketnames'   # 720h, true, s3, nl-loki
     kill %1
     ```

   - in Grafana (port-forward) Explore → Loki: `{namespace="prod", level="error"}` for the last hour.
4. **The landing (stage 1 check).** The first build of `landing-web` on `master` pushes its image; its job `deploy` fails once (this folder is not in `gitops` yet), which is expected. Take the digest and the commit from the summary of job `image` of that run:

   ```sh
   DIGEST=sha256:<64 hex>        # summary of job "image"
   SHA=<full commit SHA>         # the commit of that run
   git switch -c deploy/landing-web
   sed -i '' "s|sha256:0\{64\}|$DIGEST|; s|\"0\{40\}\"|\"$SHA\"|" apps/landing-web/prod/kustomization.yaml
   make verify && git add apps/landing-web && git commit -m "deploy: landing-web on the root domain"
   git push -u origin deploy/landing-web && gh pr create --fill --base master
   ```

   After the merge "Deployed: landing-web-prod" arrives in "Deploys", and from then on every merge in `landing-web` opens its deploy PR itself. Check:

   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' https://nick-lukashik.com                 # 200
   curl -sI https://nick-lukashik.com/health/ready | grep -i x-app-version             # the commit SHA
   kubectl -n kube-system logs deploy/traefik --tail=20 | grep request_Cf-Connecting-Ip   # JSON log with the client address
   ```

Check that project `prod` cannot deploy to `kube-system`; nothing is created:

```sh
argocd app create deny-test --project prod --repo https://github.com/nick-lukashik/gitops.git \
  --path apps/landing-web/prod --dest-server https://kubernetes.default.svc --dest-namespace kube-system
# FATA ... application destination ... namespace kube-system is not permitted in project 'prod'
```

Check that a pod with `privileged: true` is not created in `prod`:

```sh
kubectl -n prod run priv-test --image=busybox --restart=Never \
  --overrides='{"spec":{"containers":[{"name":"t","image":"busybox","securityContext":{"privileged":true}}]}}'
# Error from server (Forbidden): ... violates PodSecurity "restricted:v1.36"
```

Network check: a throwaway pod in `prod` has no service labels, so only the namespace default applies and it reaches nothing, neither DNS nor Loki. kube-router applies the policies to a new pod a few seconds after it starts, so the check waits 15 seconds first:

```sh
kubectl -n prod run np-test --image=busybox:1.37 --restart=Never --rm -i --overrides='{"spec":{
  "securityContext":{"runAsNonRoot":true,"runAsUser":65534,"seccompProfile":{"type":"RuntimeDefault"}},
  "containers":[{"name":"np-test","image":"busybox:1.37","command":["sh","-c",
    "sleep 15; nslookup kubernetes.default.svc.cluster.local; wget -T 5 -qO- http://loki.monitoring.svc.cluster.local:3100/ready || echo blocked"],
  "securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}}}]}}'
# nslookup: timed out; wget: blocked
```

## Deploy and smoke

A merge of a deploy PR (or a rollback PR) changes `apps/<service>/prod/kustomization.yaml`. Workflow `.github/workflows/smoke.yml` then runs `smoke.yml@v1` of `nick-lukashik/.github` for each changed service: it waits until `https://<host>/health/ready` answers with header `x-app-version` equal to the deployed SHA (Argo CD polls git every 3 minutes), checks `/`, and posts the result to the Telegram topic "Deploys". It needs the org secret `OPS_TELEGRAM_TOKEN` and the variables `OPS_TELEGRAM_CHAT_ID`, `OPS_TELEGRAM_TOPIC_DEPLOYS` shared with `gitops`. Removed once Argo CD reports GitHub deployments.

## Updates

- **Chart.** Change `targetRevision` in `application.yaml`, `make verify`, PR. The bootstrap takes the same version.
- **K3s.** When the K3s version in `infra` changes, compare the Traefik chart of K3s (`manifests/traefik.yaml` in `k3s-io/k3s`) and update `K3S_TRAEFIK_CHART_VERSION` in `scripts/lib.sh` and `scripts/k3s-traefik-values.yaml`.
- **Cloudflare ranges** in `platform/traefik-config/helmchartconfig.yaml` (`trustedIPs`): compare with `https://www.cloudflare.com/ips-v4` and `https://www.cloudflare.com/ips-v6`:

  ```sh
  diff <(curl -s https://www.cloudflare.com/ips-v4; echo; curl -s https://www.cloudflare.com/ips-v6) \
       <(sed -n 's/^ *- \([0-9a-f:.]*\/[0-9]*\)$/\1/p' platform/traefik-config/helmchartconfig.yaml)
  ```

- **Authenticated Origin Pulls CA** (`platform/traefik-config/cloudflare-origin-pull-ca.pem`) is valid until 2029-11-01. Source: `https://developers.cloudflare.com/ssl/static/authenticated_origin_pull_ca.pem`.

## Runbooks

- [docs/runbook/deploy.md](docs/runbook/deploy.md): the diff before a merge, rollback, pausing auto-sync, a failed migration.
- [docs/runbook/access.md](docs/runbook/access.md): Argo CD, Grafana, Alertmanager over port-forward; the admin password; repo access of a public `gitops`.
- [docs/resources.md](docs/resources.md): memory and disk budget, priorities, Pod Security.
- [Recovery](https://github.com/nick-lukashik/infra/blob/master/docs/recovery.md) (`infra`): RPO/RTO, restore on a clean server, the drill.
