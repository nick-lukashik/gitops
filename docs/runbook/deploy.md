# Deploys: review, rollback, pause, failed migration

A service is deployed by merging a PR in `gitops` that changes `apps/<service>/prod`. Argo CD syncs Application `<service>-prod` on its own: auto-sync, prune, self-heal, 3 retries.

Commands run from the root of `gitops` on the Mac. `kubectl` reaches the cluster over Tailscale (kubeconfig from `infra/node/k3s/kubeconfig.sh`). Below, `SVC` is the folder name in `apps/`.

```sh
SVC=landing-web
```

## Review a change before the merge

A deploy PR first: look at the check `e2e` and at the deployed set it tested ([e2e/README.md](../../e2e/README.md)). The `master` ruleset requires that check, so GitHub holds the merge until it passes; only the owner's bypass gets past it.

```sh
gh pr checks <PR number>        # e2e: pass
scripts/versions.sh             # on master: the deployed set now
```

- Red or still running: do not merge. A failed run has the artifact `e2e-report-deploy`: the Playwright report, traces and `compose.log`.
- The job summary of the run lists the set under test: service, source commit, digest. It must show this PR's digest for this service and, for the others, what `scripts/versions.sh` prints on `master`. If another deploy was merged after the run, the set is out of date: `gh pr update-branch <PR number>` starts a new run (a re-run would test the same merge commit).

Then, for any PR:

1. What changes in the manifests, `master` against the PR branch (no cluster needed):

   ```sh
   gh pr checkout <PR number>
   git fetch origin master
   git worktree add /tmp/gitops-master origin/master
   diff -u <(kubectl kustomize /tmp/gitops-master/apps/$SVC/prod) <(kubectl kustomize apps/$SVC/prod)
   git worktree remove /tmp/gitops-master
   ```

2. How the PR branch differs from what runs in the cluster (server-side, applies nothing):

   ```sh
   kubectl kustomize apps/$SVC/prod | kubectl diff --server-side -f -
   ```

3. `make verify`: the same checks as CI.

## Roll a service back

Migrations follow expand/contract: the old version of the code works on the new schema, so rolling the code back is safe.

```sh
git switch master && git pull
git log --oneline -n 10 -- apps/$SVC/prod          # the deploy commit with the new digest
git switch -c rollback/$SVC
git revert --no-edit <sha>
git push -u origin rollback/$SVC
gh pr create --fill --base master
```

Merging this PR is the rollback. Check:

```sh
kubectl -n argocd get application $SVC-prod
kubectl -n prod get deploy $SVC -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
```

## Pause auto-sync of one service

For manual debugging, so that self-heal does not restore the state from git. ApplicationSet `apps-prod` leaves the field `automated.enabled` alone (`ignoreApplicationDifferences`), so the pause holds.

Pause:

```sh
kubectl -n argocd patch application $SVC-prod --type merge \
  -p '{"spec":{"syncPolicy":{"automated":{"enabled":false}}}}'
kubectl -n argocd get application $SVC-prod -o jsonpath='{.spec.syncPolicy.automated}{"\n"}'
```

Resume (Argo CD brings the service back to git at once):

```sh
kubectl -n argocd patch application $SVC-prod --type merge \
  -p '{"spec":{"syncPolicy":{"automated":{"enabled":true}}}}'
kubectl -n argocd get application $SVC-prod -w
```

Anything changed by hand during the pause is overwritten. What has to stay goes to git through a PR first.

The platform applications (`root`, `argocd`, `cert-manager`, ...) have no self-heal for their own Application: `root` syncs them only on a new commit. A platform application is paused with the same command and its name, and nothing is merged to `master` until the pause ends. The one exception is the recovery PR of [postgres.md](postgres.md).

## The migration failed

An api runs Job `<service>-migrate` (`node dist/db/migrate.js`, same image, config and secrets) on every sync, before the new pods: it is an Argo CD `Sync` hook in wave 0, after the secrets (wave -1) and before the Deployment (wave 1); [components/README.md](../../components/README.md) has the reasons it is not `PreSync`. If the Job fails, the sync stops, the Deployment does not change and the old version keeps running. Argo CD retries the sync 3 times, and `Sync failed` arrives in the Telegram topic "Alerts".

1. Status and logs:

   ```sh
   kubectl -n argocd get application $SVC-prod -o jsonpath='{.status.operationState.message}{"\n"}'
   kubectl -n prod get job $SVC-migrate
   kubectl -n prod logs job/$SVC-migrate --all-containers
   ```

   A Job pod in `CreateContainerConfigError` waits for its ConfigMap or Secret: `kubectl -n prod get configmap,secret | grep $SVC`.
2. Fix the migration in the service repo. The new build opens a new deploy PR; merging it runs the Job again (`hook-delete-policy: BeforeHookCreation` deletes the old Job first).
3. If the new version is not needed, roll the deploy PR back as in "Roll a service back": the old digest, whose migrations already ran.

Nobody recreates the Job by hand or runs migrations in the cluster.
