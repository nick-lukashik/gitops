-- One database per api, owned by its own login role, as in the cluster
-- (platform/data/stores/postgres.yaml): a service sees only its own tables.
-- The passwords are generated for every run (tests/stack.ts) and reach this
-- script as environment variables of the container.
\getenv id_password PG_ID_PASSWORD
\getenv notifications_password PG_NOTIFICATIONS_PASSWORD
\getenv wallet_password PG_WALLET_PASSWORD
\getenv pay_password PG_PAY_PASSWORD

CREATE ROLE id LOGIN PASSWORD :'id_password';
CREATE DATABASE id OWNER id;

CREATE ROLE notifications LOGIN PASSWORD :'notifications_password';
CREATE DATABASE notifications OWNER notifications;

CREATE ROLE wallet LOGIN PASSWORD :'wallet_password';
CREATE DATABASE wallet OWNER wallet;

CREATE ROLE pay LOGIN PASSWORD :'pay_password';
CREATE DATABASE pay OWNER pay;
