# apps

Services. Every folder `apps/<service>/prod` becomes Application `<service>-prod` in AppProject `prod` (namespace `prod`): auto-sync, prune (last), self-heal, `ServerSideApply`, 3 retries.

| Folder | What |
|---|---|
| `_example-web/prod` | template of a web service (Next.js). Built and checked in CI, never deployed (`apps/_*` is excluded) |
| `_example-api/prod` | template of an api service (NestJS), same |
| `landing-web/prod` | the site on the root domain (repo `landing-web`, from `next-starter`) |
| `id-web/prod` | the account site on `id.<domain>` (repo `id-web`) |
| `id-api/prod`, `notifications-api/prod`, `wallet-api/prod` | the account services, internal: no route (`components/internal`), reached by id-web and each other |
| `digests/prod` | the daily digest of Google Analytics in the Telegram topic Digests (repo `digests`): a CronJob, no server |

## A service folder

`<service>` is the folder name, the repository name and the image name `ghcr.io/nick-lukashik/<service>`. The deploy PR (`deploy-pr.yml` of `nick-lukashik/.github`) finds the folder and the image by it.

```
apps/<service>/prod/
  kustomization.yaml                  components, config, image digest
  service.yaml                        local config: name, subdomain (never deployed)
  <service>-secrets.sealedsecret.yaml optional: secret env (SECRETS.md)
```

`kustomization.yaml`:

| Key | What |
|---|---|
| `namespace: prod` | always |
| `resources` | `service.yaml`, the SealedSecret if any |
| `components` | `../../../components/service`, then `../../../components/web` or `../../../components/api`, then `../../../components/subdomain` unless the service is on the root domain, or `../../../components/internal` for an api without a route |
| `configMapGenerator` | `<service>-config`: non-secret env, `KEY=value` literals. The name hash rolls the pods on every change |
| `images` | one entry `name: ghcr.io/nick-lukashik/<service>` + `digest: sha256:…`; no `newName`, no `newTag` |
| `commonAnnotations` | `nick-lukashik.com/source-sha` and `nick-lukashik.com/source-repo`: the deploy PR updates them |
| `replacements` | values derived from the host, e.g. `SITE_URL` of a web (see `_example-web`): the domain is written only in `components/settings` |
| `patches` | optional overrides, e.g. more memory for one service |

`service.yaml` holds ConfigMap `service` (`data.name: <service>`) and, for a subdomain, ConfigMap `route` (`data.subdomain`). Only one level of subdomain: the wildcard certificate covers `*.<domain>`.

What the components give a service (ports, probes, security, waves): [components/README.md](../components/README.md).

## New service

```sh
SVC=landing-web KIND=web                            # SVC = repository name; KIND = web or api
cp -R apps/_example-$KIND apps/$SVC
grep -rl "example-$KIND" apps/$SVC | xargs sed -i '' "s/example-$KIND/$SVC/g"
[ "$KIND" = api ] && mv apps/$SVC/prod/example-api-secrets.sealedsecret.yaml apps/$SVC/prod/$SVC-secrets.sealedsecret.yaml
```

Then:

1. `service.yaml`: the subdomain in ConfigMap `route`, or delete it and `components/subdomain` for the root domain.
2. `kustomization.yaml`: the env of the service in `configMapGenerator`; `digest` and `source-sha` of the first image (summary of job `image` in the service repo). A zero digest would deploy an image that does not exist. From then on the deploy PRs keep both current.
3. Secrets: seal `<service>-secrets` ([SECRETS.md](../SECRETS.md)), or drop the file and its `resources` line.
4. Callers of an api: the called api lists them by name in `patches` of its own `kustomization.yaml` (see `apps/wallet-api/prod`). A web or api pod may try to reach any api (NetworkPolicy `api-clients`), and only a listed caller gets through. A new call between services needs its line, and a missing one shows up only in prod, as a timeout: e2e runs without network policies. Any other destination of a service (a new data store, an external API not on 443) is a NetworkPolicy change in `components/` or `platform/policies/`, reviewed like any other.
5. `make verify`.

### Per-service smoke paths

The gitops smoke caller reads `nl-gitops/smoke-paths` from the rendered IngressRoute
and passes it as `check-paths` to the reusable workflow. Use space-separated,
read-only paths that return HTTP 200: the web default is `/`, the API default
is `/openapi.json`. Override the annotation in the service folder with a real
functional check. The example API uses `/api/v1/notes?limit=1`; the example web
uses `/ /api/v1/notes?limit=1`, so a degraded readiness response cannot hide a
broken backend. Do not include tokens or other secrets in paths.
