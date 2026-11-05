# Secrets of gitops

Only SealedSecrets are in git; the repo is public, and a sealed value is safe there as long as the Sealed Secrets key stays in Bitwarden. Values live in Bitwarden, folder `nick-lukashik/infra`, and are sealed on the Mac with the public certificate `bootstrap/sealed-secrets.crt`. A value is never printed to the terminal or written to disk. CI fails if a `kind: Secret` with `data` or `stringData` gets into the repo (`make secrets`).

## Table

| Secret | Namespace | Keys | Bitwarden | Created by | Used by |
|---|---|---|---|---|---|
| `sealed-secrets-key` | `kube-system` | `tls.crt`, `tls.key` | `sealed-secrets-key`, `sealed-secrets-crt` | `bootstrap/install.sh` | key of the Sealed Secrets controller |
| `cf-dns01-token` | `cert-manager` | `api-token` | `cf-dns01-token` | kubeseal | ClusterIssuer `letsencrypt` |
| `argocd-notifications-secret` | `argocd` | `telegram-token` | `ops-telegram` | kubeseal | Argo CD Notifications, service `telegram` |
| `ops-telegram` | `monitoring` | `token` | `ops-telegram` | kubeseal | Alertmanager, receiver `telegram` |
| `hc-watchdog` | `monitoring` | `url` | `hc-watchdog` | kubeseal | Alertmanager, receiver `healthchecks` (Watchdog) |
| `loki-r2` | `monitoring` | `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | `r2-loki` (`uri`, `username`, `password`) | kubeseal | Loki: chunks and index in R2 bucket `nl-loki`. The endpoint holds the account ID, so it is sealed too |
| `grafana-admin` | `monitoring` | `admin-user`, `admin-password` | not stored: random, nobody signs in with it | kubeseal | built-in Grafana admin |
| `grafana-auth-proxy` | `monitoring` | `whitelist` | not stored: the pod network of the cluster | kubeseal | `auth.proxy.whitelist` of Grafana (E4) |
| `<service>-secrets` | `prod` | secret env of the service (`KEY`) | `<service>-secrets`; for the account services generated and sealed with the data stores, plus `google-oauth` and `resend-smtp` merged in | kubeseal ([Service secrets](#service-secrets), [Data stores](#data-stores)) | `envFrom` of the pods and the api migrate Job |
| `digests-secrets` | `prod` | `GA_PROPERTY_ID`, `GA_SERVICE_ACCOUNT_JSON`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_TOPIC_ID` | `ga-digest` (the JSON key, in its notes), `ops-telegram`; the chat and topic ids as in `ops-telegram-topics` | kubeseal | `envFrom` of CronJob `digests` |

Not secrets, but kept next to them in Bitwarden:

| Value | Bitwarden | Goes to |
|---|---|---|
| ids of the supergroup and of the topics "Alerts", "Deploys", "Digests" (`message_thread_id`) | `ops-telegram-topics` | `components/settings/settings.yaml`, `telegram.chatId` and `telegram.topics.*`, an ordinary PR. The digest does not read them: its chat and topic are sealed in `digests-secrets`, and nothing reads `telegram.topics.digests`. To move the digest, merge a new `TELEGRAM_TOPIC_ID` into that file with `kubeseal --merge-into` ([Data stores](#data-stores)) |
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

`cf-dns01-token`, checked at Cloudflare first (the token must be active):

```sh
"$S" get cf-dns01-token | tr -d '\n' | { read -r t; printf 'header = "Authorization: Bearer %s"\n' "$t"; } |
  curl -s --config - https://api.cloudflare.com/client/v4/user/tokens/verify | jq -r .result.status   # active
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

## Data stores

Namespace `data` (`platform/data/stores/secrets.sealedsecret.yaml`). Everything but the R2 key is random and stored nowhere in the clear: the values were generated and sealed in one step (stage E3), and the services' URLs in `<service>-secrets` carry the same passwords. To change one, generate a new value and seal both sides together.

| Secret | Keys | Used by |
|---|---|---|
| `pg-id`, `pg-notifications`, `pg-wallet`, `pg-pay` | `username`, `password` (`kubernetes.io/basic-auth`) | the database owner of each api; `pg-id` bootstraps the cluster |
| `redis-auth` | `password` | `requirepass` of Redis (id-api) |
| `rabbitmq-definitions` | `definitions.json` | RabbitMQ users, one per api (SHA-256 password hashes), and their permissions |
| `pg-r2` | `ACCESS_KEY_ID`, `ACCESS_SECRET_KEY`, `ENDPOINT` | Barman Cloud: base backups and WAL to R2 `nl-pg-backups` |

`pg-r2` from the R2 key `r2-pg-backups`, merged into the file without touching the other secrets:

```sh
f=platform/data/stores/pg-r2.yaml
"$S" bundle ENDPOINT=r2-pg-backups:uri ACCESS_KEY_ID=r2-pg-backups:username ACCESS_SECRET_KEY=r2-pg-backups:password |
  kubectl create secret generic pg-r2 -n data --from-env-file=/dev/stdin --dry-run=client -o yaml |
  kubeseal --cert "$CRT" --format yaml >"$f"
```

Then replace the `pg-r2` document at the end of `secrets.sealedsecret.yaml` with the content of `$f` and delete `$f`. The URI of the item is the S3 endpoint without a path (`https://<account-id>.r2.cloudflarestorage.com`): the sidecar takes it as `AWS_ENDPOINT_URL_S3`.

A value from Bitwarden that joins an existing `<service>-secrets` (Google, Resend) is merged with `kubeseal --merge-into`: the other keys stay as they are and are never decrypted.

```sh
"$S" bundle GOOGLE_CLIENT_ID=google-oauth:username GOOGLE_CLIENT_SECRET=google-oauth:password |
  kubectl create secret generic id-api-secrets -n prod --from-env-file=/dev/stdin --dry-run=client -o yaml |
  kubeseal --cert "$CRT" --format yaml --merge-into apps/id-api/prod/id-api-secrets.sealedsecret.yaml
"$S" get resend-smtp:password | tr -d '\n' | { read -r k; printf 'smtps://resend:%s@smtp.resend.com:465' "$k"; } |
  kubectl create secret generic notifications-api-secrets -n prod --from-file=SMTP_URL=/dev/stdin --dry-run=client -o yaml |
  kubeseal --cert "$CRT" --format yaml --merge-into apps/notifications-api/prod/notifications-api-secrets.sealedsecret.yaml
```

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
