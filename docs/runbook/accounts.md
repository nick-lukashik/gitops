# Accounts: a copy of the data, deletion on request

The privacy policy promises both on request, through the contact on the site, answered within 30 days. There is no self-service deletion yet (`.github/docs/identity.md`, "Not in this stage yet"). Each api has its own database in cluster `pg` ([postgres.md](postgres.md)), and `user_id` in the other databases is the id of the user in `id` with no foreign key to it, so each database is done on its own.

| Database | What it holds about a person | On deletion |
|---|---|---|
| `id` | the account (email, name, language), linked Google accounts, passkeys, sessions (browser, IP), roles, grants, sign-in code requests (by email), sign-in codes of other sites | deleted |
| `notifications` | the inbox, the record of the welcome email | deleted |
| `wallet` | the wallets, the ledger `wallet_tx` and its refs | kept, the wallet restricted (below) |
| `pay` | nothing yet: pay-api is not deployed | once it is, its payments are payment records and are kept like the ledger |

**Why the wallet is kept.** The policy says payment records are kept as long as accounting rules require, and the ledger is the record of coins bought and spent: `wallet_tx` and `wallet_refs` refuse UPDATE and DELETE for every role (wallet-api migration `0001`). The wallet is anonymized instead of deleted: once the account is gone, its `user_id` names nobody, since the email, the name, Google and the passkeys were only in `id`. Write `reason` of an `adjust` without personal data: it stays too.

Nothing else needs a step: Redis holds only hashes of refresh tokens by session id and rate-limit counters (by a digest of the email, the user id or the IP), which expire by themselves (30 days at most) and open nothing once the session rows are gone; published outbox rows carry the user id, never the email or the name, and are purged after 7 days. Server logs (Loki) keep their lines for 30 days and Postgres backups 14 days, then the data is gone from them too.

## Before anything

1. Make sure the request comes from the owner of the account: write to its email address and act on the answer from that address. A Telegram handle proves nothing about an account.
2. For a deletion, tell the person that it cannot be undone and that unspent coins are lost: they have no cash value (terms, "Coins").

## Set up

Commands run from the Mac (kubeconfig as in [deploy.md](deploy.md)). `psql` runs as `postgres` in the primary and reads the SQL from stdin, so psql variables such as `:'uid'` work.

```sh
EMAIL='person@example.com'
PRIMARY=$(kubectl -n data get cluster pg -o jsonpath='{.status.currentPrimary}')
pg() { kubectl -n data exec -i "$PRIMARY" -c postgres -- psql -X -v ON_ERROR_STOP=1 "$@"; }

USER_ID=$(pg -d id -At -v email="$EMAIL" <<'SQL'
SELECT id FROM users WHERE email = lower(:'email');
SQL
)
echo "$USER_ID"   # one uuid; empty: no account with this email, stop here
```

## A copy of the data

One JSON document per database. Hashes of codes and tokens and passkey public keys stay out: they are not about the person and help nobody. Send the files to the account's email address, then delete them from the Mac.

```sh
pg -d id -At -v uid="$USER_ID" -v email="$EMAIL" > "id-$USER_ID.json" <<'SQL'
SELECT json_build_object(
    'account', (SELECT row_to_json(u) FROM (
        SELECT id, email, display_name, locale, status, created_at, updated_at FROM users WHERE id = :'uid') u),
    'google', (SELECT coalesce(json_agg(i ORDER BY i.created_at), '[]') FROM (
        SELECT subject, email, created_at FROM identities WHERE user_id = :'uid') i),
    'passkeys', (SELECT coalesce(json_agg(p ORDER BY p.created_at), '[]') FROM (
        SELECT name, aaguid, transports, backed_up, created_at, last_used_at FROM passkeys WHERE user_id = :'uid') p),
    'sessions', (SELECT coalesce(json_agg(s ORDER BY s.created_at), '[]') FROM (
        SELECT client_id, auth_method, user_agent, ip, created_at, last_active_at, revoked_at, revoked_reason
        FROM sessions WHERE user_id = :'uid') s),
    'roles', (SELECT coalesce(json_agg(r ORDER BY r.created_at), '[]') FROM (
        SELECT role, created_at, revoked_at FROM role_bindings WHERE user_id = :'uid') r),
    'grants', (SELECT coalesce(json_agg(g ORDER BY g.created_at), '[]') FROM (
        SELECT service, plan, valid_until, revoked_at, created_at FROM grants WHERE user_id = :'uid') g),
    'signInCodeRequests', (SELECT coalesce(json_agg(c ORDER BY c.created_at), '[]') FROM (
        SELECT created_at, expires_at, consumed_at, delivery_status FROM login_challenges WHERE email = lower(:'email')) c)
);
SQL

pg -d notifications -At -v uid="$USER_ID" > "notifications-$USER_ID.json" <<'SQL'
SELECT json_build_object(
    'inbox', (SELECT coalesce(json_agg(n ORDER BY n.created_at), '[]') FROM (
        SELECT kind, params, read_at, created_at FROM notifications WHERE user_id = :'uid') n)
);
SQL

pg -d wallet -At -v uid="$USER_ID" > "wallet-$USER_ID.json" <<'SQL'
SELECT json_build_object(
    'wallets', (SELECT coalesce(json_agg(w ORDER BY w.unit), '[]') FROM (
        SELECT unit, balance, state, created_at FROM wallets WHERE user_id = :'uid') w),
    'history', (SELECT coalesce(json_agg(t ORDER BY t.created_at), '[]') FROM (
        SELECT created_at, unit, kind, source, amount, balance_after, ref, reason FROM wallet_tx WHERE user_id = :'uid') t)
);
SQL
```

## Delete the account

In this order: `id` first, so the person can no longer sign in, then the inbox, then the wallet. Each step is one transaction; `DELETE n` shows what each table lost.

1. `id`. The foreign keys from `users` cascade anyway; the explicit statements show the counts. `login_challenges` has no `user_id`: its rows go by email.

   ```sh
   pg -d id -v uid="$USER_ID" -v email="$EMAIL" <<'SQL'
   BEGIN;
   DELETE FROM authorization_codes WHERE user_id = :'uid';
   DELETE FROM sessions WHERE user_id = :'uid';
   DELETE FROM identities WHERE user_id = :'uid';
   DELETE FROM passkeys WHERE user_id = :'uid';
   DELETE FROM role_bindings WHERE user_id = :'uid';
   DELETE FROM grants WHERE user_id = :'uid';
   DELETE FROM login_challenges WHERE email = lower(:'email');
   DELETE FROM users WHERE id = :'uid';
   COMMIT;
   SQL
   ```

   The next refresh of any of those sessions finds no row and is refused, so every site signs the person out; an access token already issued works for up to 5 minutes more (`.github/docs/identity.md`, "Revocation latency").
2. `notifications`. The other delivery records hold a sign-in request id or a payment id, never the address or the text.

   ```sh
   pg -d notifications -v uid="$USER_ID" <<'SQL'
   BEGIN;
   DELETE FROM notifications WHERE user_id = :'uid';
   DELETE FROM deliveries WHERE idempotency_key = 'welcome:' || :'uid';
   COMMIT;
   SQL
   ```

3. `wallet`: restricted, so nothing can spend from it; the ledger stays as it is.

   ```sh
   pg -d wallet -v uid="$USER_ID" <<'SQL'
   UPDATE wallets SET state = 'restricted', updated_at = now() WHERE user_id = :'uid';
   SQL
   ```

4. Note the date and the user id (never the email: this repo is public) in Bitwarden, note `account-deletions`. A point-in-time restore to a moment before the deletion brings the account back, and the deletion is run again from that note (`infra` `docs/recovery.md`).

## Check

Every count in `id` and `notifications` is 0; every wallet is `restricted`, and its ledger rows are still there.

```sh
pg -d id -v uid="$USER_ID" -v email="$EMAIL" <<'SQL'
SELECT
    (SELECT count(*) FROM users WHERE id = :'uid' OR email = lower(:'email')) AS users,
    (SELECT count(*) FROM sessions WHERE user_id = :'uid') AS sessions,
    (SELECT count(*) FROM identities WHERE user_id = :'uid') AS identities,
    (SELECT count(*) FROM passkeys WHERE user_id = :'uid') AS passkeys,
    (SELECT count(*) FROM role_bindings WHERE user_id = :'uid') AS role_bindings,
    (SELECT count(*) FROM grants WHERE user_id = :'uid') AS grants,
    (SELECT count(*) FROM login_challenges WHERE email = lower(:'email')) AS login_challenges,
    (SELECT count(*) FROM authorization_codes WHERE user_id = :'uid') AS authorization_codes;
SQL

pg -d notifications -v uid="$USER_ID" <<'SQL'
SELECT
    (SELECT count(*) FROM notifications WHERE user_id = :'uid') AS notifications,
    (SELECT count(*) FROM deliveries WHERE idempotency_key = 'welcome:' || :'uid') AS welcome;
SQL

pg -d wallet -v uid="$USER_ID" <<'SQL'
SELECT unit, balance, state FROM wallets WHERE user_id = :'uid';
SELECT count(*) AS ledger_rows FROM wallet_tx WHERE user_id = :'uid';
SQL
```

Then answer the person: the account is deleted; backups drop it within 14 days and logs within 30; the payment history is kept, with no name or email attached, as accounting rules require.
