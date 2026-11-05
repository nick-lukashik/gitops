# e2e

The deployed set end to end on one machine: the images of `apps/<service>/prod` by digest, real Postgres, Redis and RabbitMQ, Mailpit as the mail server, and one Playwright scenario that goes through id-web the way a person does. The services' own e2e run against mocks; this is the only test of the calls between them. A second suite, the [failure scenarios](#failure-scenarios), stops parts of the same stack on purpose.

| File | What |
|---|---|
| [`compose.yaml`](compose.yaml) | the stack: the services, their migrations, data stores, Mailpit |
| [`compose.failure.yaml`](compose.failure.yaml) | on top of it for the failure scenarios: data stores with volumes, 70 s access tokens, second replicas of id-web and id-api |
| [`pay-api.env`](pay-api.env) | the pay-api image by digest: pay-api is not in the deployed set |
| [`postgres-init.sql`](postgres-init.sql) | one database and owner role per api, as in `platform/data/stores/postgres.yaml` |
| [`tests/`](tests/) | the Playwright package (own `package.json` and lockfile); `stack.ts` starts and removes the stack; `failure/` holds the failure scenarios |
| [`../scripts/versions.sh`](../scripts/versions.sh) | the deployed set: service, source commit, image digest |

## Run

Docker, Node 26 and pnpm 12. Once:

```sh
pnpm --dir e2e/tests install
pnpm --dir e2e/tests exec playwright install chromium
```

Then one command, from the repo root:

```sh
pnpm --dir e2e/tests test
```

The global setup (`tests/stack.ts`) writes `e2e/.env` (git-ignored): the project name and ports, the images from `scripts/versions.sh --env` and `pay-api.env`, and fresh random secrets (the ES256 signing key, `SESSION_SECRET`, the internal tokens, the pepper, the store passwords). It removes what a killed run left under the same project name, then `docker compose up --wait`: migrations first (`node dist/db/migrate.js`, as the cluster's migrate Job), then the services until healthy. After the tests it saves every log to `tests/test-results/compose.log` and removes the stack. A first run pulls the images (about 3.5 GB on disk); with the images present a run takes about 45 s on an M-series Mac, where the amd64 service images run emulated.

| Variable | Effect |
|---|---|
| `<SERVICE>_IMAGE` | another image for one service, e.g. `ID_API_IMAGE=ghcr.io/nick-lukashik/id-api:sha-<commit>` for a candidate before its deploy PR |
| `PAY_API_IMAGE` | another pay-api than the pin in `pay-api.env` |
| `COMPOSE_PROJECT_NAME`, `E2E_WEB_PORT`, `E2E_MAILPIT_PORT`, `E2E_WEB_2_PORT` | where the stack runs; default `nl-e2e`, 3900, 3901, 3902 (the last only for the failure scenarios). `stack.ts` passes them to compose through `.env` |
| `E2E_SUITE=failure` | the failure scenarios instead of the deploy-PR suite; `test:failure` sets it |
| `E2E_KEEP=1` | keeps the stack after the run; `docker compose down -v` in `e2e/` removes it |

id-web is on <https://localhost:3900> (TLS by `id-web-tls`, as Traefik in prod, so the cookies have prod's names; the browser accepts the certificate of its own CA), Mailpit (UI and API) on <http://localhost:3901>, both on 127.0.0.1 only. While a stack is up (`E2E_KEEP=1`), `docker compose` in `e2e/` works on it as usual. A local change of the stack for one run goes into `e2e/compose.override.yaml` (git-ignored; compose or `stack.ts` merges it), never into `compose.yaml`.

One project name and its ports are one run: a setup or teardown removes whatever runs under that name. Two worktrees can run at once when each has its own, in the second one for example:

```sh
COMPOSE_PROJECT_NAME=nl-e2e-2 E2E_WEB_PORT=3910 E2E_MAILPIT_PORT=3911 E2E_WEB_2_PORT=3912 pnpm --dir e2e/tests test
```

### The pay-api image

pay-api publishes images but has no `apps/pay-api/prod`, so the deployed set has no digest for it. The scenario still runs on every deploy PR, with the image pinned in [`pay-api.env`](pay-api.env). To bump it, take the digest of the commit's tag and put it with the commit in that file, in a PR:

```sh
docker buildx imagetools inspect ghcr.io/nick-lukashik/pay-api:sha-<commit> --format '{{.Manifest.Digest}}'
```

Once `apps/pay-api/prod` exists, the deployed digest wins over the pin, and the file can go.

## CI

[`.github/workflows/e2e.yml`](../.github/workflows/e2e.yml) runs the same command on PRs that change `apps/*/prod/**` (the deploy PRs) or the e2e, the failure scenarios every night, with the result in the Telegram topic Alerts, and both by hand (`workflow_dispatch`, with an optional pay-api image instead of the pin, and `notify` to send the result too). The job summary records the deployed set under test and the pay-api image; a failed run uploads the Playwright report, traces and `compose.log` (artifact `e2e-report-deploy` or `e2e-report-failure`). The check `e2e` is required on `master`: every PR reports it, and a PR that changes none of those files passes without a run.

## What it covers

In order, one browser, a new user every run (`tests/sign-in-to-receipt.spec.ts`):

1. Sign-in with an email code: id-web → id-api → notifications-api → SMTP; the code is read from Mailpit's API.
2. The account page shows the user and this session (id-api `/me`, `/me/sessions`).
3. A new wallet has 0 coins (wallet-api).
4. A coin pack bought with the fake provider (pay-api `PAY_PROVIDER=fake`): checkout, the test provider's page, pay; the coins arrive through the outbox, RabbitMQ and wallet-api's consumer. Pressing pay again in a second tab sends the completion a second time and credits nothing; a second pack shows the exact total and one history entry per pack.
5. One receipt email per payment (pay-api → RabbitMQ → notifications-api → id-api for the address → SMTP).
6. Sign-out ends the session at id-api, not only the cookie: with the old cookie put back, the session is no longer listed as this device.

## Failure scenarios

`pnpm --dir e2e/tests test:failure`, about 8 min with the images present. Tagged `@failure` in the title, so the deploy PRs do not run them. They are serial on one stack, with a new person (browser, email, client address) per test, and stop and start its parts with `docker compose` (`tests/failure/harness.ts`). A failed test gets the whole stack back before the next one.

| Spec in `tests/failure/` | What happens | What must hold |
|---|---|---|
| `concurrency` | two tabs of one session past the refresh threshold load at once, in rounds | both stay signed in, also past the grace window of the old token |
| `concurrency` | sign-in, refresh and sign-out, each step on the replica the test chooses | a code asked for on one replica works on the other; each refreshes from the other's token; sign-out on one ends the session on the other |
| `redis-down` | Redis stops | a code request and a right code get an error page and no code email goes out; pages keep working while the access token lasts, then say unavailable without a sign-out; back up, the session, the waiting code and new sign-ins work with nothing restarted |
| `smtp-down` | Mailpit stops | the sign-in page says the code could not be sent, on the first request and on "send a new code"; back up, a new code arrives, and the failed one never does |
| `postgres-down` | Postgres stops | every page answers with its unavailable state, not the error page; back up, the APIs and their background work (outbox, consumers, email jobs) recover with nothing restarted |
| `broker-down` | RabbitMQ stops during a payment, and with an event in the queue | the credit arrives afterwards, once; one receipt; sign-in works meanwhile |
| `broker-down` | wallet-api is killed mid-flow, and while an event waits for it | once; the wallet page says unavailable meanwhile |
| `payment-replay` | the fake provider's completion in two tabs at once, the same request again, the event published again | one credit, one receipt |
| `payment-replay` | pay-api is killed with the row of a checkout committed, then the retry with the same key | one payment, one credit |

After every scenario, and whichever way it ended, its lines of every container's log (`docker compose logs`) must hold no test user's email, sign-in code, JWT or bearer token, refresh token, password or token of the run, connection string with a password, or private key (`log-check.spec.ts` tests the rules themselves). A finding is printed with the value masked.

The stack differs from the deploy-PR one in `compose.failure.yaml`:

- Postgres, Redis and RabbitMQ have volumes, as in the cluster, so a store that stops comes back with its data. Redis has the cluster's AOF settings.
- Access tokens last 70 s, against 300 s in prod. id-web refreshes a token with less than 60 s left, so ten seconds after a refresh the next one is due. 60 s is the shortest id-api allows, but then every request refreshes, including a page's own prefetches, a chain prod's 300 s never makes.
- `id-api-2` and `id-web-2` (port 3902) are the second replicas, as separate services, not `--scale`: id-web has a fixed host port, and a scaled API behind one name would leave it to chance which replica takes a step. The browser's cookies ignore the port, so one session is on both sites; `id-web-2` calls only `id-api-2`, and the test checks each one's log for the refresh it asked for.

A test marked `test.fixme` stands for a defect in a service, named in its comment; details are in the private backlog. When the service is fixed, remove the mark.

## What it does not cover

- Passkeys and Google sign-in, sign-in for the other sites (landing-web), the inbox page.
- The cluster around the services: Traefik, TLS and the `__Host-` cookies (the stack is plain http), NetworkPolicies, Kubernetes replicas behind a Service, probe timings, restarts of a pod that exits, SealedSecrets. The env in `compose.yaml` is written from each service's `src/config/env.ts`; a value missing only in the cluster's config is not caught.
- One RabbitMQ user for every api (the cluster has one per api with its own permissions); fresh databases only, no migration over existing data.
- Real email (Resend over smtps) and the real payment provider.
- In the failure scenarios: a dependency that hangs rather than goes away (a stopped container closes its connections, and Docker's DNS stops knowing its name); a store that loses data (a kill of Redis within its fsync second, a restored backup); an outage longer than a consumer's retries (the event goes to the DLQ); an SMTP outage for the emails of events; id-api, notifications-api or id-web themselves going down; a pod taken out of traffic by its readiness probe (here a service that is not ready still takes requests and answers them with its error). A kill of wallet-api is not sure to land between its commit and its ack; the republished event is what proves its deduplication.
