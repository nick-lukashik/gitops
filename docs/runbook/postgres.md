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

   and without `plugins` (a restored cluster must not archive into the same path, [below](#the-archive-folder-after-a-restore)).
2. Check the data in `pg-restore`, then point the services at it (`pg-restore-rw` in their `DATABASE_URL`) or restore into `pg` itself as [on a clean server](#into-pg-itself-on-a-clean-server), which deletes it first.

### Into `pg` itself on a clean server

There is no old cluster to compare with, and a restored `pg` needs no change in the services: their sealed `DATABASE_URL` still points at `pg-rw`, and the passwords come from the same secrets. The operator reads `bootstrap` only when it creates a cluster, and `postgres.yaml` creates `pg` empty (`initdb`), so the recovery goes in by a PR. Not run yet: the first data drill should check it, and the Drill row of `infra` `docs/recovery.md` still has to add this path.

The order matters. The PR sets a new `serverName`, and the archiver reads the spec of the running cluster on every call: a `pg` still running when the PR syncs, empty or real, writes its WAL into the new folder within minutes. The recovery then finds that folder in use and stops ([below](#the-archive-folder-after-a-restore)). So `pg` goes first, and the PR is merged after it.

1. If Argo CD has already created `pg`, look for a backup of that empty cluster. It cannot write WAL into the archive (below), but `pg-nightly` may have put a base backup there, and a restore with no target takes the newest one. If a backup shows `completed`, step 2 needs a `recoveryTarget.targetTime` before that backup.

   ```sh
   kubectl -n data get backups
   ```

2. Open a PR that changes `postgres.yaml` and do not merge it yet: `recovery` instead of `initdb`, the folder to read and a new folder to write ([below](#the-archive-folder-after-a-restore)). Without `recoveryTarget` the restore replays all the WAL in R2, up to the last archived segment.

   ```yaml
   bootstrap:
     recovery:
       source: backup
       # As in initdb: without them CNPG adds a database and a role "app".
       database: id
       owner: id
       secret:
         name: pg-id
   externalClusters:
     - name: backup
       plugin:
         name: barman-cloud.cloudnative-pg.io
         parameters:
           barmanObjectName: r2
           serverName: pg
   plugins:
     - name: barman-cloud.cloudnative-pg.io
       isWALArchiver: true
       parameters:
         barmanObjectName: r2
         serverName: pg-20261105
   ```

   The one exception: before `bootstrap/install.sh` there is no `pg` to delete, so merge it at once. `pg` never exists empty, and steps 1, 3 and 4 fall away.
3. Pause auto-sync of `data` ([deploy.md](deploy.md#pause-auto-sync-of-one-service)) and delete `pg`: the empty one, or the real one if you came here from `pg-restore`. A new cluster must not find the old volume.

   ```sh
   kubectl -n argocd patch application data --type merge -p '{"spec":{"syncPolicy":{"automated":{"enabled":false}}}}'
   kubectl -n data delete cluster pg
   kubectl -n data wait --for=delete pvc/pg-1 --timeout=2m
   ```

   If the wait times out, stop here with the pause on and find out why (`kubectl -n data describe pvc pg-1`): do not merge or resume while the volume is there. When it returns, the cluster can make no more backups: look once more as in step 1, and add the target to the PR if a backup of the empty cluster has completed since. Until step 4 nothing else goes to `master`: a new commit can make `root` sync `data` and end the pause, and the old `postgres.yaml` would create `pg` empty again.
4. Merge the PR. `root` may now sync `data` and end the pause, which is fine from here on: what it applies is the recovery. Argo CD reads git every few minutes, so wait until `data` has seen the merge before resuming: a sync of the older commit would also create `pg` empty. The resume creates `pg` from the new `bootstrap`.

   ```sh
   MERGED=$(gh pr view <PR number> --json mergeCommit --jq .mergeCommit.oid)
   until [ "$(kubectl -n argocd get application data -o jsonpath='{.status.sync.revision}')" = "$MERGED" ]; do sleep 10; done
   kubectl -n argocd patch application data --type merge -p '{"spec":{"syncPolicy":{"automated":{"enabled":true}}}}'
   ```

5. Check: the databases are there with their data, and WAL reaches the new folder.

   ```sh
   kubectl -n data get cluster pg                     # STATUS "Cluster in healthy state"
   kubectl -n data exec -it pg-1 -c postgres -- psql -l
   kubectl -n data get cluster pg -o jsonpath='{.status.conditions[?(@.type=="ContinuousArchiving")].status}'   # True
   ```

6. Take a backup now ([Backups](#backups)): the new folder has no base backup yet, so nothing can be restored from it, and `pg-nightly` runs at 03:00 UTC.
7. A second PR puts `bootstrap.initdb` back and removes `externalClusters`; `serverName` in `plugins` stays. The running cluster does not read them, and the next rebuild must not replay this restore by itself.

### The archive folder after a restore

Backups and WAL go to `s3://nl-pg-backups/pg/<serverName>/`. `serverName` is the cluster name unless `plugins` sets it, so the first folder is `pg/pg`. A restored cluster starts a new timeline, and Barman refuses a folder that already holds an archive: the pod stays in `Setting up primary`, its log says `Expected empty archive`. Do not skip the check with the annotation `cnpg.io/skipEmptyWalArchiveCheck`: the new timeline would mix with the old one.

| In the restored cluster | `serverName` |
|---|---|
| `externalClusters`: the folder to read | where the lost cluster wrote: `serverName` in `plugins` of `postgres.yaml` before this PR, `pg` if it sets none |
| `plugins`: the folder to write | never used before, such as `pg-<date>`. It stays in `postgres.yaml` from now on |

A `pg-restore` that stays in use gets `plugins` too, with no `serverName`: its own name is a new folder.

A new folder that took WAL because the PR synced while a `pg` still ran is no longer new: delete `pg` as in [step 3](#into-pg-itself-on-a-clean-server), then set another never-used `serverName` by a further PR and go on with step 4.

The 14-day retention of the ObjectStore trims only the folder the cluster writes to, and the bucket has no lifecycle rule. The old folder still holds the moments before the restore: keep it for 14 days, then delete it in the R2 dashboard.

## Connections

`max_connections` 200. Each api pod keeps a pool of `DATABASE_POOL_MAX` (5): at 4 replicas of 4 apis that is 80. When connections get tight, a CNPG `Pooler` (PgBouncer, transaction mode) goes in front for the apps, while the migrate Jobs and pg-boss keep the direct `pg-rw` (session features: the per-connection timeouts the apps send, advisory locks).
