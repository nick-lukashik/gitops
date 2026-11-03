# Access to Argo CD, Grafana and Alertmanager

Until stage E4 (the admin console) the web UIs are not published. Access is `kubectl port-forward` through the kube API, which listens only on the Tailscale address. Needed: Tailscale on the Mac and the kubeconfig from `infra/node/k3s/kubeconfig.sh`. Network policies do not apply to a port-forward.

## Argo CD

```sh
kubectl -n argocd port-forward svc/argocd-server 8080:80
```

UI: `http://localhost:8080/argocd`. CLI (`brew install argocd`):

```sh
argocd login localhost:8080 --plaintext --grpc-web-root-path /argocd --username admin
```

### Change the admin password (owner step)

1. Create the Bitwarden item `argocd-admin` with a new password (Bitwarden generator).
2. Copy the initial password to the clipboard without printing it:

   ```sh
   kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d | pbcopy
   ```

3. Log in and change the password; the CLI asks for both:

   ```sh
   argocd login localhost:8080 --plaintext --grpc-web-root-path /argocd --username admin
   argocd account update-password
   pbcopy </dev/null
   ```

4. Delete the initial secret and check:

   ```sh
   kubectl -n argocd delete secret argocd-initial-admin-secret
   kubectl -n argocd get secret argocd-initial-admin-secret   # NotFound
   ```

No anonymous access, `exec` and badges are off, the default role is empty, `role:admin` only for `admin` (`platform/argocd/values.yaml`). In stage E4: OIDC to id (client `argocd`), group `ops-argocd` → `role:admin`, route `platform/argocd/admin-route`, then `admin.enabled: false`.

## Grafana

```sh
kubectl -n monitoring port-forward svc/grafana 3000:80
```

UI: `http://localhost:3000/grafana/`. Until E4 the login is anonymous with role Editor (`auth.anonymous` in `platform/monitoring/grafana/values.yaml`); from outside Grafana is unreachable: there is no route, and its NetworkPolicy lets in only Traefik (and Prometheus for metrics). The login form and basic auth are off. In E4 `platform/monitoring/grafana/admin-route` is enabled and `auth.anonymous` is turned off in the same PR.

## Prometheus and Alertmanager

```sh
kubectl -n monitoring port-forward svc/kube-prometheus-stack-prometheus 9090
kubectl -n monitoring port-forward svc/kube-prometheus-stack-alertmanager 9093
```

A test alert to the topic "Alerts"; `amtool` is in the Alertmanager container:

```sh
kubectl -n monitoring exec alertmanager-kube-prometheus-stack-alertmanager-0 -c alertmanager -- \
  amtool --alertmanager.url=http://localhost:9093 alert add TestAlert \
  severity=warning namespace=test --annotation=summary='Test alert'
```

## Repo access of the public gitops

`gitops` is public. Argo CD still reads it over SSH with the read-only deploy key `argocd-deploy-key` (`bootstrap/repo-credentials.sh`); that works for a public repo too. Optional: drop the key and read over HTTPS without credentials. Both URLs are already allowed in `projects/`.

1. PR: change the repo URL and remove the key from the bootstrap.

   ```sh
   git switch -c chore/public-repo
   grep -rlF 'git@github.com:nick-lukashik/gitops.git' platform bootstrap |
     xargs sed -i '' 's#git@github.com:nick-lukashik/gitops.git#https://github.com/nick-lukashik/gitops.git#'
   git rm bootstrap/repo-credentials.sh
   ```

   In `bootstrap/install.sh` remove step 4: the comment `# 4. Repo access` and the three lines below it. `make verify`, PR, merge.

2. After every application has synced with the new URL:

   ```sh
   kubectl -n argocd patch application root --type merge \
     -p '{"spec":{"source":{"repoURL":"https://github.com/nick-lukashik/gitops.git"}}}'
   kubectl -n argocd get applications            # all Synced
   kubectl -n argocd delete secret repo-gitops
   ```

3. Delete the deploy key in the repo settings and the item `argocd-deploy-key` in Bitwarden.
