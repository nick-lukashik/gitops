# Rules for changes in gitops

The repo describes everything that runs in the cluster. Argo CD applies a merge to `master` with no manual steps. Layout: [README.md](README.md), secrets: [SECRETS.md](SECRETS.md).

## Check

```sh
make verify
```

A green `make verify` before every PR (needs Docker). CI runs the same set, job `ci / verify`.

## Never

- Plain secrets: `kind: Secret` with `data` or `stringData`, tokens, passwords, keys in values or manifests. SealedSecrets only, commands in [SECRETS.md](SECRETS.md).
- An image by tag, `latest` above all. In `apps/*/prod` only a `digest`. A chart only with an exact version in `targetRevision`.
- Manual `kubectl apply`, `kubectl edit`, `helm install` in docs and runbooks as a way to change something. A change is a PR. The exception is `bootstrap/install.sh` for a new cluster.
- The domain, the Telegram group or topic ids anywhere except `components/settings/settings.yaml`. Values derived from the host (such as `SITE_URL`) come from the route by a `replacements` entry (see `apps/_example-web`).
- Server IP addresses and email addresses. The public Cloudflare ranges only in `platform/traefik-config/helmchartconfig.yaml`.
- Anything that must not be public: the repo is public, history included. No account identifiers (the Cloudflare account ID, Tailscale names), no notes about open weaknesses in comments or docs ([README.md](README.md#public-repository)).
- A NetworkPolicy rule that allows any destination or any source in `prod` or `monitoring`. `make netpol` fails on such an egress rule in `apps/*/prod`; the rest is review.

## How things are built

- A new service: copy `apps/_example-web` or `apps/_example-api` to `apps/<service>` ([apps/README.md](apps/README.md)). The folder name, the repository and the image `ghcr.io/nick-lukashik/<service>` are the same name. The ApplicationSet `apps-prod` creates `<service>-prod` by itself.
- What a service gets from the platform is the [service runtime contract](https://github.com/nick-lukashik/.github/blob/master/docs/service-contract.md), implemented by `components/service` + `components/api` or `components/web`. A change there is a change of the contract: update the contract and the starters with it.
- A third-party image (not built from a starter) gets its own manifests and an entry in `THIRD_PARTY` of `scripts/check-apps.sh` (none today).
- A platform component: an Application in `platform/<component>/application.yaml`, a line in `platform/kustomization.yaml`, a sync-wave in dependency order.
- A new alert: a rule in `platform/monitoring/rules/` with `severity` and `runbook_url`, a unit test in `tests/` (without it CI fails), and its section in `docs/runbook/alerts.md`, which `runbook_url` points to.
- Comments and documents: English only; YAML comments short.
