#!/usr/bin/env bash
# Alloy pipeline: syntax (alloy fmt), then the loki.process blocks of
# config.alloy run on fixtures (tests/*.log) and the output is checked:
# secrets masked, Redis lines rebuilt as JSON, levels normalised.
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

DIR=platform/monitoring/alloy
WORK=$CACHE/alloy
rm -rf "$WORK"
mkdir -p "$WORK"

alloy fmt "/repo/$DIR/config/config.alloy" >/dev/null || fail "alloy fmt $DIR/config/config.alloy"
echo "ok   alloy fmt config.alloy"

# Processing blocks only; their final receiver becomes loki.echo.
{
  cat "$DIR/tests/harness.alloy"
  awk '/^loki\.process "/ { on = 1 } on { print } on && /^}/ { on = 0; print "" }' "$DIR/config/config.alloy" |
    sed 's/loki\.write\.default\.receiver/loki.echo.out.receiver/'
} >"$WORK/test.alloy"

id=$(docker run -d --user "$(id -u):$(id -g)" -v "$WORK:/work:ro" -v "$REPO/$DIR/tests:/tests:ro" \
  "$IMG_ALLOY" run --storage.path=/tmp/alloy /work/test.alloy)
trap 'docker rm -f "$id" >/dev/null 2>&1 || true' EXIT

expected=$(($(wc -l <"$DIR/tests/app.log") + $(wc -l <"$DIR/tests/redis.log")))
for _ in $(seq 1 30); do
  docker logs "$id" >"$WORK/out.log" 2>&1
  [[ $(grep -c 'received log entry' "$WORK/out.log") -ge $expected ]] && break
  sleep 1
done
grep 'received log entry' "$WORK/out.log" >"$WORK/entries.log" || fail "no output from alloy (see $WORK/out.log)"
[[ $(wc -l <"$WORK/entries.log") -ge $expected ]] || fail "expected $expected entries (see $WORK/out.log)"

# Values from the fixtures that must not reach Loki. Without the timestamps of the log
# line: their nanoseconds can read as one of these numbers.
sed -E 's/(^ts| entry_timestamp)=[^ ]+//g' "$WORK/entries.log" >"$WORK/values.log"
for leak in abc ss1 tok1 123456 4321 sec1 cookie1 bearer1 eyJhbGci; do
  if grep -qF -- "$leak" "$WORK/values.log"; then
    fail "not masked: $leak"
  fi
done
for want in '\"token\":\"[redacted]\"' '\"statusCode\":200' '\"code\":\"[redacted]\"' \
  'Bearer [redacted]' 'level=\"error\"' 'level=\"warn\"' 'structured_metadata="{\"pod\":\"web-1\"}"' \
  '\"msg\":\"Ready to accept connections tcp\"'; do
  grep -qF -- "$want" "$WORK/entries.log" || fail "missing in output: $want"
done
if grep -qF 'level=\"<nil>\"' "$WORK/entries.log"; then
  fail "empty level became a label"
fi
echo "ok   alloy pipeline: secrets masked, Redis as JSON, levels"
