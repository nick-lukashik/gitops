#!/usr/bin/env bash
# amtool check-config on the Alertmanager config and templates rendered from
# kube-prometheus-stack values (after Helm tpl with components/settings).
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

rendered=$OUT/helm/kube-prometheus-stack.yaml
[[ -f $rendered ]] || fail "no $rendered; run make render first"

WORK=$CACHE/alertmanager
rm -rf "$WORK"
mkdir -p "$WORK"

secret='select(.kind == "Secret" and .metadata.name == "alertmanager-kube-prometheus-stack-alertmanager")'
for key in alertmanager.yaml telegram.tmpl; do
  yq -r "$secret | .data[\"$key\"]" "$(rel "$rendered")" | base64 -d >"$WORK/$key" ||
    fail "no $key in the rendered Alertmanager secret"
done

# The config reads templates from /etc/alertmanager/config/*.tmpl.
docker run --rm --user "$(id -u):$(id -g)" -v "$WORK:/etc/alertmanager/config:ro" \
  --entrypoint /bin/amtool "$IMG_ALERTMANAGER" check-config /etc/alertmanager/config/alertmanager.yaml ||
  fail "amtool check-config"
