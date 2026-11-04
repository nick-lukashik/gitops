#!/usr/bin/env bash
# The RabbitMQ definitions as the pod loads them, on a real broker: the image,
# config, mounts and topology of the rendered StatefulSet, with a stand-in for
# the sealed users. It must boot, keep an event published before any consumer
# started, boot again on its data, and accept what the services declare at
# startup (check-rabbitmq-topology.mjs). A wrong definition would stop the broker
# from booting or a consumer from starting.
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# The client library of the services (their package.json).
AMQPLIB=2.2.0

RENDERED=$OUT/kustomize/platform_data_stores.yaml
[[ -f $RENDERED ]] || fail "no $RENDERED; run make render first"
WORK=$CACHE/rabbitmq
rm -rf "$WORK"
mkdir -p "$WORK/conf" "$WORK/definitions"

rendered() { yq -N -r "$1" "$(rel "$RENDERED")"; }
POD='select(.kind == "StatefulSet" and .metadata.name == "rabbitmq") | .spec.template.spec'
CONFIG='select(.kind == "ConfigMap" and .metadata.name == "rabbitmq-config") | .data'

rendered "$CONFIG | .[\"rabbitmq.conf\"]" >"$WORK/conf/rabbitmq.conf"
rendered "$CONFIG | .enabled_plugins" >"$WORK/conf/enabled_plugins"
definitions=$(sed -n 's/^load_definitions = //p' "$WORK/conf/rabbitmq.conf")
[[ $definitions == /* ]] || fail "rabbitmq.conf has no load_definitions"
conf=$(rendered "$POD | .containers[0].volumeMounts[] | select(.name == \"conf\") | .mountPath")
# What Docker cannot show: fsGroup on every mount of the data volume breaks the cookie file.
[[ $(rendered "$POD | .securityContext.fsGroupChangePolicy") == OnRootMismatch ]] ||
  fail "fsGroupChangePolicy must be OnRootMismatch: the broker refuses a group-readable .erlang.cookie when its pod comes back"

# What a definition that is a Secret looks like to the broker: its users, the vhost, their permissions.
standin='{"users":[{"name":"stand-in","password_hash":"","hashing_algorithm":"rabbit_password_hashing_sha256","tags":[]}],"vhosts":[{"name":"/"}],"permissions":[{"user":"stand-in","vhost":"/","configure":".*","write":".*","read":".*"}]}'

while IFS=$'\t' read -r path subpath volume; do
  [[ $path == "$definitions" || $path == "$definitions"/* ]] || continue
  [[ $subpath != - ]] || fail "$volume is mounted at $path as a whole: its ..data directories stop the broker from booting, mount each file with subPath"
  configmap=$(rendered "$POD | .volumes[] | select(.name == \"$volume\") | .configMap.name // \"\"")
  if [[ -n $configmap ]]; then
    rendered "select(.kind == \"ConfigMap\" and .metadata.name == \"$configmap\") | .data[\"$subpath\"]" >"$WORK/definitions/$(basename "$path")"
  else
    printf '%s\n' "$standin" >"$WORK/definitions/$(basename "$path")"
  fi
done < <(rendered "$POD | .containers[0].volumeMounts[] | [.mountPath, .subPath // \"-\", .name] | @tsv")
chmod -R a+rX "$WORK"

env=()
while IFS= read -r line; do
  env+=(-e "$line")
done < <(rendered "$POD | .containers[0].env[] | .name + \"=\" + .value")
image=$(rendered "$POD | .containers[0].image")
uid=$(rendered "$POD | .securityContext.runAsUser")

name=rabbitmq-check-$$
trap 'docker rm -f -v "$name" >/dev/null 2>&1 || true' EXIT

wait_for_broker() {
  for _ in $(seq 1 60); do
    if [[ $(docker inspect -f '{{.State.Running}}' "$name") != true ]]; then
      docker logs --tail 30 "$name" >&2
      fail "the broker stopped $1: the definitions, see above"
    fi
    docker exec "$name" rabbitmq-diagnostics -q check_running >/dev/null 2>&1 && return 0
    sleep 2
  done
  docker logs --tail 30 "$name" >&2
  fail "the broker is not running after 2 minutes $1"
}

docker run -d --name "$name" --user "$uid:$uid" "${env[@]}" \
  -v "$WORK/conf:$conf:ro" -v "$WORK/definitions:$definitions:ro" "$image" >/dev/null
wait_for_broker "at its first boot"
docker exec "$name" rabbitmqctl -q add_user check check >/dev/null
docker exec "$name" rabbitmqctl -q set_permissions check '.*' '.*' '.*' >/dev/null

cp scripts/check-rabbitmq-topology.mjs "$WORK/"
node_in_work() {
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$WORK:/work" -w /work --network "container:$name" \
    "$IMG_NODE" "$@" </dev/null
}
node_in_work npm install --silent --no-audit --no-fund --ignore-scripts "amqplib@$AMQPLIB" || fail "npm install amqplib"
node_in_work node check-rabbitmq-topology.mjs definitions/ publish || fail "the definitions, before any consumer"
docker restart "$name" >/dev/null
wait_for_broker "when it restarted on its data"
node_in_work node check-rabbitmq-topology.mjs definitions/ consume || fail "the definitions, with the consumers"
echo "ok   rabbitmq: $image boots from the definitions and takes what the services declare"
