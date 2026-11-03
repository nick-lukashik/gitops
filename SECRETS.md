# Secrets of gitops

Only SealedSecrets are in git; the repo is public, and a sealed value is safe there as long as the Sealed Secrets key stays in Bitwarden. Values live in Bitwarden, folder `nick-lukashik/infra`, and are sealed on the Mac with the public certificate `bootstrap/sealed-secrets.crt`. A value is never printed to the terminal or written to disk. CI fails if a `kind: Secret` with `data` or `stringData` gets into the repo (`make secrets`).

## Table

| Secret | Namespace | Keys | Bitwarden | Created by | Used by |
|---|---|---|---|---|---|
| `sealed-secrets-key` | `kube-system` | `tls.crt`, `tls.key` | `sealed-secrets-key`, `sealed-secrets-crt` | `bootstrap/install.sh` | key of the Sealed Secrets controller |
| `repo-gitops` | `argocd` | `type`, `url`, `sshPrivateKey` | `argocd-deploy-key` | `bootstrap/install.sh` (`bootstrap/repo-credentials.sh`) | repo access of Argo CD |
| `cf-dns01-token` | `cert-manager` | `api-token` | `cf-dns01-token` | kubeseal | ClusterIssuers `letsencrypt-staging`, `letsencrypt` |
| `argocd-notifications-secret` | `argocd` | `telegram-token` | `ops-telegram` | kubeseal | Argo CD Notifications, service `telegram` |
| `ops-telegram` | `monitoring` | `token` | `ops-telegram` | kubeseal | Alertmanager, receiver `telegram` |
| `hc-watchdog` | `monitoring` | `url` | `hc-watchdog` | kubeseal | Alertmanager, receiver `healthchecks` (Watchdog) |
| `loki-r2` | `monitoring` | `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | `r2-loki` (`uri`, `username`, `password`) | kubeseal | Loki: chunks and index in R2 bucket `nl-loki`. The endpoint holds the account ID, so it is sealed too |
| `grafana-admin` | `monitoring` | `admin-user`, `admin-password` | not stored: random, nobody signs in with it | kubeseal | built-in Grafana admin |
| `grafana-auth-proxy` | `monitoring` | `whitelist` | not stored: the pod network of the cluster | kubeseal | `auth.proxy.whitelist` of Grafana (E4) |
| `<service>-secrets` | `prod` | secret env of the service (`KEY`) | `<service>-secrets` | kubeseal ([Service secrets](#service-secrets)) | `envFrom` of the pods and the api migrate Job |

Not secrets, but kept next to them in Bitwarden:

| Value | Bitwarden | Goes to |
|---|---|---|
| ids of the supergroup and of the topics "Alerts", "Deploys", "Digests" (`message_thread_id`) | `ops-telegram-topics` | `components/settings/settings.yaml`, `telegram.chatId` and `telegram.topics.*`, an ordinary PR |
| `admin` password of Argo CD | `argocd-admin` | typed into `argocd account update-password` (`docs/runbook/access.md`) |

Placeholder files in the repo have `spec.encryptedData: {}`. Until a placeholder is replaced, the controller creates an empty Secret: cert-manager issues no certificate, Alertmanager sends nothing, Grafana does not start without `grafana-admin`, Loki does not start without `loki-r2`.

## Preparation

Once: `brew install kubeseal` (version 0.41.x, like the controller). Every time, from the root of `gitops`, with `infra` next to it:

```sh
export BW_SESSION="$(bw unlock --raw)"
S=../infra/scripts/secrets.sh
CRT=bootstrap/sealed-secrets.crt
openssl x509 -in "$CRT" -noout -subject -enddate
```

`secrets.sh get <name>` without a file writes the value only into a pipe. `tr -d '\n'` removes the trailing newline of one-line values.

## Commands

`cf-dns01-token`:

```sh
"$S" get cf-dns01-token | tr -d '\n' |
  kubectl create secret generic cf-dns01-token -n cert-manager --from-file=api-token=/dev/stdin --dry-run=client -o yaml |
  kubeseal --cert "$CRT" --format yaml >platform/cert-manager/config/cf-dns01-token.sealedsecret.yaml
```

`argocd-notifications-secret`:

```sh
"$S" get ops-telegram | tr -d '\n' |
  kubectl create secret generic argocd-notifications-secret -n argocd --from-file=telegram-token=/dev/stdin --dry-run=client -o yaml |
  kubeseal --cert "$CRT" --format yaml >platform/argocd/config/argocd-notifications-secret.sealedsecret.yaml
```

`ops-telegram`:

```sh
"$S" get ops-telegram | tr -d '\n' |
  kubectl create secret generic ops-telegram -n monitoring --from-file=token=/dev/stdin --dry-run=client -o yaml |
  kubeseal --cert "$CRT" --format yaml >platform/monitoring/kube-prometheus-stack/config/ops-telegram.sealedsecret.yaml
```

`hc-watchdog`:

```sh
"$S" get hc-watchdog | tr -d '\n' |
  kubectl create secret generic hc-watchdog -n monitoring --from-file=url=/dev/stdin --dry-run=client -o yaml |
  kubeseal --cert "$CRT" --format yaml >platform/monitoring/kube-prometheus-stack/config/hc-watchdog.sealedsecret.yaml
```

`loki-r2`, from the R2 key `r2-loki` (`infra` `docs/secrets.md`, created after the apply of `infra` step 1). The three fields go through one pipe as an env file:

```sh
"$S" bundle S3_ENDPOINT=r2-loki:uri S3_ACCESS_KEY_ID=r2-loki:username S3_SECRET_ACCESS_KEY=r2-loki:password |
  kubectl create secret generic loki-r2 -n monitoring --from-env-file=/dev/stdin --dry-run=client -o yaml |
  kubeseal --cert "$CRT" --format yaml >platform/monitoring/loki/config/loki-r2.sealedsecret.yaml
```

`grafana-admin`, a random password:

```sh
openssl rand -base64 32 | tr -d '\n' |
  kubectl create secret generic grafana-admin -n monitoring --from-literal=admin-user=admin --from-file=admin-password=/dev/stdin --dry-run=client -o yaml |
  kubeseal --cert "$CRT" --format yaml >platform/monitoring/grafana/config/grafana-admin.sealedsecret.yaml
```

`grafana-auth-proxy`, the pod network of the node is taken from the cluster:

```sh
kubectl get nodes -o jsonpath='{.items[0].spec.podCIDR}' |
  kubectl create secret generic grafana-auth-proxy -n monitoring --from-file=whitelist=/dev/stdin --dry-run=client -o yaml |
  kubeseal --cert "$CRT" --format yaml >platform/monitoring/grafana/config/grafana-auth-proxy.sealedsecret.yaml
```

After any command: `make verify`, commit the `*.sealedsecret.yaml` file, PR.

## Service secrets

Every service reads its secret env from Secret `<service>-secrets` in `prod` (`envFrom`, optional), made from SealedSecret `apps/<service>/prod/<service>-secrets.sealedsecret.yaml`. Argo CD applies it in sync wave -1, before the migrate Job and the pods ([components/README.md](components/README.md)). Non-secret env goes to the ConfigMap `<service>-config` (`configMapGenerator` in the same folder), never here.

The values live in the Bitwarden item `<service>-secrets`, one `KEY=value` per line in its note (api: `DATABASE_URL`, `REDIS_URL`, `RABBITMQ_URL` and the like):

```sh
SVC=<service>
"$S" get "$SVC-secrets" |
  kubectl create secret generic "$SVC-secrets" -n prod --from-env-file=/dev/stdin --dry-run=client -o yaml |
  kubeseal --cert "$CRT" --format yaml >"apps/$SVC/prod/$SVC-secrets.sealedsecret.yaml"
```

Then add the file to `resources` of `apps/<service>/prod/kustomization.yaml`, `make verify`, PR. A service without secrets has no such file: the pods start without it.

## Check

A test secret is sealed on the Mac and decrypted in the cluster.

```sh
printf 'ok' | kubectl create secret generic seal-test -n prod --from-file=v=/dev/stdin --dry-run=client -o yaml |
  kubeseal --cert "$CRT" --format yaml | kubectl create -f -
kubectl -n prod get secret seal-test -o jsonpath='{.data.v}' | base64 -d; echo
kubectl -n prod delete sealedsecret seal-test
```

State of all SealedSecrets: `kubectl get sealedsecrets -A` (column `SYNCED` = `True`).
