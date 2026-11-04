# e2e

The deployed set end to end on one machine: the images of `apps/<service>/prod` by digest, real Postgres, Redis and RabbitMQ, Mailpit as the mail server, and one Playwright scenario that goes through id-web the way a person does. The services' own e2e run against mocks; this is the only test of the calls between them.

| File | What |
|---|---|
| [`compose.yaml`](compose.yaml) | the stack: the services, their migrations, data stores, Mailpit |
| [`postgres-init.sql`](postgres-init.sql) | one database and owner role per api, as in `platform/data/stores/postgres.yaml` |
| [`tests/`](tests/) | the Playwright package (own `package.json` and lockfile); `stack.ts` starts and removes the stack |
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

The global setup (`tests/stack.ts`) writes `e2e/.env` (git-ignored): the images from `scripts/versions.sh --env` and fresh random secrets (the ES256 signing key, `SESSION_SECRET`, the internal tokens, the pepper, the store passwords). Then `docker compose up --wait`: migrations first (`node dist/db/migrate.js`, as the cluster's migrate Job), then the services until healthy. After the tests it saves every log to `tests/test-results/compose.log` and removes the stack. A first run pulls the images (about 3 GB on disk); with the images present a run takes about 30 s on an M-series Mac, where the amd64 service images run emulated.

| Variable | Effect |
|---|---|
| `<SERVICE>_IMAGE` | another image for one service, e.g. `ID_API_IMAGE=ghcr.io/nick-lukashik/id-api:sha-<commit>` for a candidate before its deploy PR |
| `PAY_API_IMAGE` | pay-api has no `apps/pay-api/prod` yet: without this the payment tests skip. Once the folder exists the deployed set has it |
| `E2E_KEEP=1` | keeps the stack after the run; `docker compose -f e2e/compose.yaml down -v` removes it |

id-web is on <http://localhost:3900>, Mailpit (UI and API) on <http://localhost:3901>, both on 127.0.0.1 only. While a stack is up (`E2E_KEEP=1`), `docker compose` in `e2e/` works on it as usual. A local change of the stack for one run goes into `e2e/compose.override.yaml` (git-ignored; compose merges it by itself), never into `compose.yaml`.

## CI

[`.github/workflows/e2e.yml`](../.github/workflows/e2e.yml) runs the same command on PRs that change `apps/*/prod/**` (the deploy PRs) or the e2e, and by hand (`workflow_dispatch`, with an optional pay-api image). The job summary records the deployed set under test; a failed run uploads the Playwright report, traces and `compose.log` (artifact `e2e-report`). It is not a required check.

## What it covers

In order, one browser, a new user every run (`tests/sign-in-to-receipt.spec.ts`):

1. Sign-in with an email code: id-web → id-api → notifications-api → SMTP; the code is read from Mailpit's API.
2. The account page shows the user and this session (id-api `/me`, `/me/sessions`).
3. A new wallet has 0 coins (wallet-api).
4. A coin pack bought with the fake provider (pay-api `PAY_PROVIDER=fake`): checkout, the test provider's page, pay; the coins arrive through the outbox, RabbitMQ and wallet-api's consumer. Pressing pay again in a second tab sends the completion a second time and credits nothing; a second pack shows the exact total and one history entry per pack.
5. One receipt email per payment (pay-api → RabbitMQ → notifications-api → id-api for the address → SMTP).
6. Sign-out ends the session at id-api, not only the cookie: with the old cookie put back, the session is no longer listed as this device.

## What it does not cover

- Passkeys and Google sign-in, sign-in for the other sites (landing-web), the inbox page.
- The cluster around the services: Traefik, TLS and the `__Host-` cookies (the stack is plain http), NetworkPolicies, replicas, probe timings, SealedSecrets. The env in `compose.yaml` is written from each service's `src/config/env.ts`; a value missing only in the cluster's config is not caught.
- One RabbitMQ user for every api (the cluster has one per api with its own permissions); fresh databases only, no migration over existing data.
- Real email (Resend over smtps) and the real payment provider.
