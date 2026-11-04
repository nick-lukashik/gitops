# Postgres

One CloudNativePG cluster `pg` in namespace `data` (`platform/data/stores/postgres.yaml`): one instance, a database and an owner role per api (`id`, `notifications`, `wallet`, `pay`). The services reach it at `pg-rw.data.svc:5432` with the URL of their `<service>-secrets`.

## Look

```sh
kubectl -n data get cluster pg                     # STATUS "Cluster in healthy state"
kubectl -n data get backups                        # nightly base backups (03:00 UTC), phase completed
kubectl -n data get cluster pg -o jsonpath='{.status.conditions[?(@.type=="ContinuousArchiving")].status}'   # True: WAL reaches R2
kubectl -n data exec -it pg-1 -c postgres -- psql -l
```

## Backups

- WAL goes to R2 `nl-pg-backups` (`s3://nl-pg-backups/pg`) continuously, a base backup every night (ScheduledBackup `pg-nightly`), kept 14 days (ObjectStore `r2`, `retentionPolicy`). Any second of those 14 days can be restored.
- A backup now: `kubectl cnpg backup pg -n data --method plugin --plugin-name barman-cloud.cloudnative-pg.io` (the `cnpg` kubectl plugin), or a `Backup` object with the same method.

## Restore to a point in time

A restore makes a new cluster from R2; the old one stays until the new one is checked.

1. Copy `postgres.yaml` into a cluster `pg-restore` with `bootstrap.recovery` instead of `bootstrap.initdb`:

   ```yaml
   bootstrap:
     recovery:
       source: pg
       recoveryTarget:
         targetTime: "2026-11-05 12:00:00+00"
   externalClusters:
     - name: pg
       plugin:
         name: barman-cloud.cloudnative-pg.io
         parameters:
           barmanObjectName: r2
           serverName: pg
   ```

   and without `plugins` (a restored cluster must not archive into the same path).
2. Check the data in `pg-restore`, then point the services at it (`pg-restore-rw` in their `DATABASE_URL`) or restore again into `pg` after deleting it.

## Connections

`max_connections` 200. Each api pod keeps a pool of `DATABASE_POOL_MAX` (5): at 4 replicas of 4 apis that is 80. When connections get tight, a CNPG `Pooler` (PgBouncer, transaction mode) goes in front for the apps, while the migrate Jobs and pg-boss keep the direct `pg-rw` (session features: the per-connection timeouts the apps send, advisory locks).
