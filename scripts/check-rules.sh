#!/usr/bin/env bash
# PrometheusRules in platform/monitoring/rules: every alert has severity and
# runbook_url and a unit test; promtool check rules and promtool test rules pass.
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

RULES=platform/monitoring/rules
WORK=$CACHE/rules
rm -rf "$WORK"
mkdir -p "$WORK"

rule_files=()
rule_paths=()
for f in "$RULES"/*.yaml; do
  [[ $(yq -r '.kind' "/repo/$f") == PrometheusRule ]] || continue
  name=$(basename "$f" .yaml)
  yq '.spec' "/repo/$f" >"$WORK/$name.rules.yaml"
  rule_files+=("$name.rules.yaml")
  rule_paths+=("/repo/.cache/rules/$name.rules.yaml")
done
[[ ${#rule_files[@]} -gt 0 ]] || fail "no PrometheusRule in $RULES"
cp "$RULES"/tests/*.test.yaml "$WORK"/

missing=$(yq ea -N -r '.groups[].rules[] | select(has("alert")) |
  select(.labels.severity == null or .annotations.runbook_url == null) | .alert' "${rule_paths[@]}")
[[ -z $missing ]] || fail "alerts without severity or runbook_url: $missing"

alerts=$(yq ea -N -r '.groups[].rules[] | select(has("alert")) | .alert' "${rule_paths[@]}" | sort -u)
tested=$(cd "$WORK" && for t in *.test.yaml; do yq -N -r '.tests[].alert_rule_test[].alertname' "/repo/.cache/rules/$t"; done | sort -u)
untested=$(comm -23 <(echo "$alerts") <(echo "$tested"))
[[ -z $untested ]] || fail "alerts without a unit test: $untested"

run_promtool() {
  docker run --rm --user "$(id -u):$(id -g)" -v "$WORK:/work" -w /work \
    --entrypoint /bin/promtool "$IMG_PROMETHEUS" "$@"
}
run_promtool check rules "${rule_files[@]}" || fail "promtool check rules"
(cd "$WORK" && run_promtool test rules ./*.test.yaml) || fail "promtool test rules"
echo "ok   rules: $(echo "$alerts" | wc -l | tr -d ' ') alerts checked and tested"
