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

`gitops` is public: Argo CD reads it over HTTPS without credentials (`repoURL: https://github.com/nick-lukashik/gitops.git`), and the AppProjects allow only that URL. The organization has deploy keys disabled, and no repo Secret exists in `argocd`.

If the repo ever has to become private, Argo CD needs credentials first: a read-only token of a GitHub App in a SealedSecret of type `repository`, added in the same PR that changes the visibility.
