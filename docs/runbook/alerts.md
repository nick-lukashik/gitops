# Alerts

What each alert means and what to look at first. The rules are in [`platform/monitoring/rules/`](../../platform/monitoring/rules); their `runbook_url` points to the section here. Access to Grafana, Prometheus and Alertmanager: [access.md](access.md). Commands run on the Mac with the cluster kubeconfig.

`critical` alerts need action now; `warning` alerts need it today.

## Node

### NodeDiskUsageHigh

More than 80% of a node filesystem is used (warning).

```sh
kubectl get --raw "/api/v1/nodes/$(kubectl get nodes -o name | cut -d/ -f2)/proxy/stats/summary" | jq '.node.fs'
ssh deploy@<tailscale-name> 'sudo du -xh --max-depth=2 /var/lib | sort -h | tail -15'
```

The usual causes are container images (`sudo k3s crictl rmi --prune`), container logs and the Loki buffer (`emptyDir`, capped at 5 GiB). Data of services belongs in R2 or a database, not on the node disk.

### NodeDiskUsageCritical

More than 90% used (critical). The kubelet starts evicting pods at 90% (`nodefs.available<10%`), and etcd lives on the same disk. Free space first, as in [NodeDiskUsageHigh](#nodediskusagehigh), then find what grew.

### NodeDiskFillingUp

At the growth rate of the last hour the disk reaches the eviction threshold within 6 hours (critical). Find what is writing: the steps of [NodeDiskUsageHigh](#nodediskusagehigh), and `kubectl top pods -A` for a pod writing logs in a loop.

### NodeMemoryLow

Less than 10% of the memory has been available for 10 minutes (critical).

```sh
kubectl top pods -A --sort-by=memory | head -15
```

A pod near its limit is the usual cause; memory limits are in `components/service/workload.yaml` and the platform values. The budget per component: [resources.md](../resources.md).

### NodeRebootRequired

Updates that need a reboot (usually a kernel) have waited for 24 hours (warning). Unattended upgrades never reboot by themselves. Reboot at a quiet hour: `ssh deploy@<tailscale-name> sudo reboot`. Everything comes back on its own; check `kubectl get nodes` and the site afterwards.

## Platform

### CertificateExpiringSoon

A certificate expires in less than 14 days (warning). cert-manager renews 30 days ahead, so renewal has been failing for two weeks.

```sh
kubectl get certificate -A
kubectl -n traefik describe certificate <name>
kubectl -n cert-manager logs deploy/cert-manager --tail=100 | grep -i error
```

Common causes: the `cf-dns01-token` was revoked or lost a zone, or Let's Encrypt rate limits.

### TraefikHigh5xxRate

More than 5% of the responses of one router are 5xx (warning). The router name is `<namespace>-<service>@kubernetescrd`.

```sh
kubectl -n prod get pods -l app.kubernetes.io/name=<service>
kubectl -n prod logs deploy/<service> --tail=100
```

A 502 or 503 with no logs in the pod means the pod is not ready or not running; a 500 has its log line in the service. A recent deploy is the first suspect: [roll back](deploy.md#roll-a-service-back).

### ArgoCDAppOutOfSync

The live state of an application has differed from git for 15 minutes (warning): a failed sync, or a manual change in the cluster.

```sh
kubectl -n argocd get application <name> -o jsonpath='{.status.operationState.message}{"\n"}'
```

A manual change is reverted by self-heal; a failed sync shows its reason in the message above.

### ArgoCDAppDegraded

An application has been Degraded for 15 minutes (critical): a resource is unhealthy, often a Deployment whose new pods never became ready (image pull, crash, failed probe) or an api migrate Job that failed ([deploy.md](deploy.md#the-migration-failed)).

```sh
kubectl -n argocd get application <name> -o json | jq '.status.resources[] | select(.health.status != "Healthy")'
kubectl -n prod get pods
```

### LokiDiscardingSamples

Loki rejected log lines in the last 10 minutes (warning), by `reason`: `rate_limited` or `stream_limit` (a pod logging in a loop), `greater_than_max_sample_age` (old lines after an outage), `line_too_long`. Find the noisy pod with `kubectl top pods -A` and its logs; the limits are in `platform/monitoring/loki/values.yaml`.

## Workloads

### PodRestartingOften

A container restarted more than 3 times in 15 minutes (warning).

```sh
kubectl -n <namespace> describe pod <pod> | sed -n '/Last State/,/Ready/p'
kubectl -n <namespace> logs <pod> -c <container> --previous --tail=100
```

A failed liveness probe, a crash on start (bad config: the service validates its env and stops) or a dependency it cannot start without.

### ContainerOOMKilled

A container was killed at its memory limit (warning). Check `kubectl top pods` and the memory graph in Grafana: a leak grows steadily, a too-low limit is hit under normal load. Raise the limit in the service's `patches` only after the cause is clear.

## Data

The CNPG cluster `pg` in namespace `data` has one instance, `pg-1`; its backups go to R2 through the Barman Cloud plugin (`plugin-barman-cloud`, a sidecar of the pod). More in [postgres.md](postgres.md).

### PostgresInstanceDown

A Postgres instance has not answered, or its pod has not been Ready, for 5 minutes (critical). With one instance every api fails its requests on the database ([ServiceDatabaseErrors](#servicedatabaseerrors)) until it is back.

```sh
kubectl -n data get cluster pg
kubectl -n data get pod pg-1 -o wide
kubectl -n data describe pod pg-1 | sed -n '/Conditions/,$p'
kubectl -n data logs pg-1 -c postgres --tail=100
kubectl -n cnpg-system logs deploy/cnpg-cloudnative-pg --tail=100
```

Pending: the node lacks memory for the request, or the local-path volume is gone. Restarting: the log says why, often a full volume (`No space left on device`: WAL that could not be archived, see [PostgresWALArchivingFailing](#postgreswalarchivingfailing)), an OOM kill at the 1 GiB limit or a bad parameter in `postgres.yaml`. A recovery after a crash replays WAL first; the pod becomes Ready when it is done.

### PostgresWALArchivingFailing

WAL does not reach R2 (critical): the latest archive attempt failed, or WAL has waited in `pg_wal` for 15 minutes with nothing archived (a hung archiver). A restore can only reach the last archived segment, and `pg_wal` grows on the 10 GiB volume until Postgres stops.

```sh
kubectl -n data get cluster pg -o jsonpath='{.status.conditions[?(@.type=="ContinuousArchiving")]}{"\n"}'
kubectl -n data exec pg-1 -c postgres -- psql -c 'select * from pg_stat_archiver'
kubectl -n data logs pg-1 -c plugin-barman-cloud --tail=100
kubectl -n data exec pg-1 -c postgres -- du -sh /var/lib/postgresql/data/pgdata/pg_wal
```

The plugin log has the R2 answer. Usual causes: the `pg-r2` key was revoked or lost access to `nl-pg-backups`, the endpoint in `pg-r2` is wrong, an R2 outage, or the sidecar was OOM killed (256 MiB limit in the ObjectStore `r2`). Postgres retries by itself; once a segment goes through, the backlog follows.

### PostgresBackupTooOld

No base backup of the cluster has succeeded for 26 hours (warning): `pg-nightly` (03:00 UTC) failed or did not run. It fires as well when Postgres is up but the Barman Cloud plugin reports no backup at all, so the age is unknown. While WAL is archived a restore still works, from the previous base backup and with more WAL to replay.

```sh
kubectl -n data get scheduledbackup pg-nightly
kubectl -n data get backups --sort-by=.metadata.creationTimestamp | tail -5
kubectl -n data get backup <name> -o jsonpath='{.status.phase} {.status.error}{"\n"}'
kubectl -n cnpg-system logs deploy/barman-cloud-plugin-barman-cloud --tail=100
kubectl -n data logs pg-1 -c plugin-barman-cloud --tail=100
```

The causes are those of [PostgresWALArchivingFailing](#postgreswalarchivingfailing), a cluster that was not healthy at 03:00, or the plugin itself down in `cnpg-system`. After the fix take a backup now ([postgres.md](postgres.md#backups)). The age comes from the plugin's `barman_cloud_cloudnative_pg_io_last_available_backup_timestamp`, which every instance reports for its cluster; the in-tree `cnpg_collector_last_available_backup_timestamp` stays 0 with the plugin. If the backups are recent, the metric is missing: the `plugin-barman-cloud` sidecar of the pod is not running or fails to answer the instance manager.

## Services

### ServiceDatabaseErrors

Requests of a service end with 503 because Postgres is over a time budget, locked or unreachable (warning). The metric `http_server_database_failures_total{reason}` tells which: `lock_timeout` (a long transaction or a migration holds a lock), `statement_timeout` (a slow query), `pool_timeout` (the pool is exhausted), `unavailable` (Postgres is down).

### ServiceBrokerDown

A service has no RabbitMQ connection (warning). Writes still succeed and their events wait in the outbox; it reconnects by itself. Check the broker pod and the service log (`RabbitMQ connection lost`). If it lasts, [OutboxEventsStuck](#outboxeventsstuck) follows.

### ServiceConsumerDown

A consumer keeps failing to re-subscribe to its queue (critical): events of that queue are not processed. The service log says why: usually `PRECONDITION_FAILED` (the queue exists with other arguments; it has to be deleted and is then declared again) or missing permissions.

### OutboxEventsStuck

The oldest unpublished event is older than 5 minutes (critical). Events are committed but not reaching RabbitMQ: the broker is down ([ServiceBrokerDown](#servicebrokerdown)), or every publish fails (`outbox_publish_failures_total{reason}`). The `last_error` column of the `outbox` table holds the reason per event.

### OutboxEventsUnroutable

RabbitMQ returned published events because no queue is bound to their routing key (critical). Nothing is lost: they stay in the outbox and are retried. A consumer queue is missing or its binding changed; deploying the consumer (it declares its queues) fixes it.

### ServiceEventsDeadLettered

Events of a queue failed every retry, or were invalid, and moved to `<queue>.dlq` (warning). They wait there; nothing processes them.

1. The consumer's log has the error per event: `Event handling failed` with `target` `<queue>.dlq`, or `Invalid message, moving to DLQ`.
2. Fix the cause and deploy.
3. Move the dead letters back, in the service's pod:

   ```sh
   kubectl -n prod exec deploy/<service> -- node dist/messaging/replay-dlq.js <queue> --limit 100
   ```

### ServiceRedisDown

A service has no Redis connection (warning). Its cache is bypassed (reads go to Postgres) and its rate limits are not checked ([RateLimitFailingOpen](#ratelimitfailingopen)). It reconnects by itself; check the Redis pod.

### RateLimitFailingOpen

Requests got no rate-limit check because Redis was down or over its 500 ms budget (warning). What happened to them depends on the limiter: id-api's throttler let them through (log `Rate limiter unavailable, allowing requests`), id-api's sign-in limits refused them with 503 (log `Rate limiter unavailable, refusing`), so nobody can sign in meanwhile. It follows [ServiceRedisDown](#serviceredisdown) or a slow Redis; fix Redis.

## Business

Failures a user sees even though every service is up. Each counter comes from the service named in the alert.

### AuthCodeDeliveryFailing

id-api has failed to hand sign-in codes to notifications-api for 10 minutes (critical): users ask for a code and get none, so they cannot sign in. `auth_code_deliveries_total{result}` says how: `unreachable` (no answer or not 2xx: notifications-api is down, or the internal token of id-api, `NOTIFICATIONS_INTERNAL_TOKEN`, is not the one notifications-api expects), `failed` (notifications-api answered, but the mail provider refused the email or the code expired before sending).

```sh
kubectl -n prod logs deploy/id-api --tail=200 | grep 'Sign-in code delivery failed'
kubectl -n prod get pods -l app.kubernetes.io/name=notifications-api
kubectl -n prod logs deploy/notifications-api --tail=200
```

id-api logs that line only when it got no usable answer (`unreachable`, or a body it cannot parse). `failed` is not logged by id-api, so an empty grep clears nothing: the reason is in notifications-api, in its log line `Sign-in code not accepted by the provider` and in its `deliveries` table.

```sh
kubectl -n data exec pg-1 -c postgres -- psql -d notifications -c \
  "select status, attempts, last_error, updated_at from deliveries where template = 'auth.code' and status in ('failed', 'skipped') order by updated_at desc limit 20"
```

`failed`: the provider refused the email, `last_error` says why. `skipped`, `expired before sending`: the code expired first; this case has no log line in either service.

### EmailJobsFailed

notifications-api gave up on emails of a template (`welcome`, `receipt`) in the last hour (warning): the job failed every retry, so the user did not get the email. The reason of the last attempt is in the `deliveries` table:

```sh
kubectl -n data exec pg-1 -c postgres -- psql -d notifications -c \
  "select template, attempts, last_error, updated_at from deliveries where status = 'failed' order by updated_at desc limit 20"
```

Usually the mail provider: a revoked key, a quota, or a refused sender domain. Single bad addresses fail alone; many failures at once point at the provider or its credentials.

### PaymentWebhooksUnmatched

pay-api received provider webhooks it could not apply in the last 30 minutes (warning), by `result`:

- `unmatched`: no payment has the provider's payment id yet. A webhook that came before its payment is applied by itself once the payment has the id; one that stays unapplied belongs to a payment pay-api never created.
- `mismatch`: the amount or currency differs from the order. It is never applied, so the coins of that payment are not credited.

```sh
kubectl -n data exec pg-1 -c postgres -- psql -d pay -c \
  "select received_at, provider, outcome, provider_payment_id, amount_minor, currency, applied_at from webhook_events where outcome in ('unmatched', 'mismatch') order by received_at desc limit 20"
kubectl -n prod logs deploy/pay-api --tail=200 | grep -E 'unmatched|mismatch'
```

Compare each with the payment in the provider's dashboard and settle it by hand.
