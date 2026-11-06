#!/usr/bin/env bash
# Network isolation (service runtime contract, platform/policies):
# - prod denies ingress and egress by default, and NetworkPolicy api-clients
#   gives web and api pods egress to api pods;
# - an ingress rule has a "from", and a caller in the namespace is named after
#   an app of apps/ and nothing else, so that no label opens several apis;
# - monitoring and monitoring-node deny ingress by default;
# - every workload of every apps/*/prod (third-party apps included) is selected
#   by a NetworkPolicy with Egress, and no egress rule allows any destination
#   (a rule without "to", or 0.0.0.0/0 without exceptions);
# - services of the contract: egress to CoreDNS on 53 UDP and TCP; api: public
#   443 with the private, CGNAT and link-local ranges excluded;
# - Loki has a NetworkPolicy, and its only peers are Alloy, Grafana and Loki.
# Label keys under the "<domain>/" prefix are matched by suffix.
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

WORK=$CACHE/netpol
rm -rf "$WORK"
mkdir -p "$WORK"

# to_json <name> <rendered yaml...>: all documents as one JSON array; prints
# the path inside the container.
to_json() {
  local name=$1 f args=()
  shift
  for f in "$@"; do
    [[ -f $f ]] || fail "no $f; run make render first"
    args+=("$(rel "$f")")
  done
  yq ea -o=json -I=0 '[.]' "${args[@]}" >"$WORK/$name.json"
  rel "$WORK/$name.json"
}

# q <json> <expression>: evaluate on the array of documents.
q() {
  yq -p=json -o=yaml -r "$2" "$1"
}

status=0
check() {
  local what=$1 ok=$2
  if [[ $ok == true ]]; then
    echo "ok   $what"
  else
    echo "FAIL: $what" >&2
    status=1
  fi
}

# ---- Namespace defaults (platform/policies) ----
policies=$(to_json policies "$OUT/kustomize/platform_policies.yaml")
deny='.kind == "NetworkPolicy" and ((.spec.podSelector // {}) | length) == 0
  and ((.spec.ingress // []) | length) == 0 and ((.spec.egress // []) | length) == 0'
check "prod denies ingress and egress by default" "$(q "$policies" "map(select($deny
  and .metadata.namespace == \"prod\"
  and (.spec.policyTypes | any_c(. == \"Ingress\")) and (.spec.policyTypes | any_c(. == \"Egress\")))) | length > 0")"
for ns in monitoring monitoring-node; do
  check "$ns denies ingress by default" "$(q "$policies" "map(select($deny
    and .metadata.namespace == \"$ns\" and (.spec.policyTypes | any_c(. == \"Ingress\")))) | length > 0")"
done
check "prod: web and api pods have egress to api pods on 3000" "$(q "$policies" 'map(select(.kind == "NetworkPolicy"
  and .metadata.namespace == "prod"
  and ((.spec.podSelector.matchExpressions // []) | any_c((.key | test("/kind$")) and .operator == "Exists"))
  and ((.spec.egress // []) | any_c(
    ((.to // []) | any_c((.podSelector.matchLabels // {}) | to_entries | any_c((.key | test("/kind$")) and .value == "api")))
    and ((.ports // []) | any_c(.port == 3000)))))) | length > 0')"

# ---- apps/*/prod ----
for rendered in "$OUT"/kustomize/apps_*_prod.yaml; do
  [[ -f $rendered ]] || fail "no rendered apps/*/prod; run make render first"
  app=$(basename "$rendered" .yaml)
  app=${app#apps_}
  app=${app%_prod}
  json=$(to_json "app-$app" "$rendered")

  # One "key=value" line per fact.
  # shellcheck disable=SC2016 # $all, $np, ... are yq variables.
  facts=$(q "$json" '. as $all |
    ($all | map(select(.kind == "NetworkPolicy" and ((.spec.policyTypes // []) | any_c(. == "Egress"))))) as $np |
    ($all | map(select(.kind == "Deployment" and .spec.template.metadata.labels["app.kubernetes.io/component"] == "server"))
      | .[0].spec.template.metadata.labels // {}) as $server |
    ($np | map(select((.spec.podSelector.matchLabels // {}) | to_entries | all_c(. as $e | ($server | .[$e.key]) == $e.value)))) as $snp |
    ($snp | map(.spec.egress // []) | flatten) as $srules |
    [
      ($all | map(select(.kind == "Deployment" or .kind == "StatefulSet" or .kind == "DaemonSet" or .kind == "Job" or .kind == "CronJob")) | .[] |
        (.spec.jobTemplate.spec.template // .spec.template).metadata.labels as $l |
        "workload=" + .kind + "/" + .metadata.name + ":" +
        ($np | map(select((.spec.podSelector.matchLabels // {}) | to_entries | all_c(. as $e | ($l | .[$e.key]) == $e.value))) | length | tostring)),
      "open_rules=" + ($np | map(.spec.egress // []) | flatten | map(select((.to // []) | length == 0)) | length | tostring),
      "open_ingress=" + ($all | map(select(.kind == "NetworkPolicy")) | map(.spec.ingress // []) | flatten |
        map(select((.from // []) | length == 0)) | length | tostring),
      ($all | map(select(.kind == "NetworkPolicy")) | map(.spec.ingress // []) | flatten | map(.from // []) | flatten |
        map(select(has("namespaceSelector") | not)) | .[] |
        "caller=" + ((.podSelector.matchLabels // {}) | to_entries | map(.key + ":" + .value) | join(","))),
      "open_blocks=" + ($np | map(.spec.egress // []) | flatten | map(.to // []) | flatten |
        map(select(.ipBlock.cidr == "0.0.0.0/0" and ((.ipBlock.except // []) | length) == 0)) | length | tostring),
      "kind=" + ($server | to_entries | map(select(.key | test("/kind$"))) | .[0].value // ""),
      "dns=" + ($srules | map(select(
        ((.to // []) | any_c(.podSelector.matchLabels["k8s-app"] == "kube-dns"
          and .namespaceSelector.matchLabels["kubernetes.io/metadata.name"] == "kube-system"))
        and ((.ports // []) | any_c(.port == 53 and .protocol == "UDP"))
        and ((.ports // []) | any_c(.port == 53 and .protocol == "TCP")))) | length | tostring),
      "https=" + ($srules | map(select(
        ((.to // []) | any_c(.ipBlock.cidr == "0.0.0.0/0" and ((.ipBlock.except // []) as $x |
          ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16", "127.0.0.0/8"] |
          all_c(. as $c | $x | any_c(. == $c)))))
        and ((.ports // []) | length) == 1 and .ports[0].port == 443)) | length | tostring)
    ] | .[]')

  errors=()
  kind="" dns=0 https=0 open_rules=0 open_blocks=0 open_ingress=0 workloads=0
  while IFS='=' read -r key value; do
    case $key in
      workload)
        workloads=$((workloads + 1))
        [[ ${value##*:} -gt 0 ]] || errors+=("${value%:*} is not selected by a NetworkPolicy with Egress")
        ;;
      open_rules) open_rules=$value ;;
      open_ingress) open_ingress=$value ;;
      caller)
        if [[ ! $value =~ ^app\.kubernetes\.io/name:([a-z0-9-]+)$ ]]; then
          errors+=("a caller is not named by app.kubernetes.io/name alone: $value")
        elif [[ ! -d apps/${BASH_REMATCH[1]} ]]; then
          errors+=("the caller ${BASH_REMATCH[1]} has no folder in apps/")
        fi
        ;;
      open_blocks) open_blocks=$value ;;
      kind) kind=$value ;;
      dns) dns=$value ;;
      https) https=$value ;;
    esac
  done <<<"$facts"

  [[ $workloads -gt 0 ]] || errors+=("no workload rendered")
  [[ $open_rules == 0 ]] || errors+=("$open_rules egress rule(s) without 'to' allow any destination")
  [[ $open_ingress == 0 ]] || errors+=("$open_ingress ingress rule(s) without 'from' allow any source")
  [[ $open_blocks == 0 ]] || errors+=("$open_blocks egress rule(s) to 0.0.0.0/0 without exceptions")
  case $kind in
    api | web)
      [[ $dns -gt 0 ]] || errors+=("the server pods have no egress to kube-dns on 53 UDP and TCP")
      ;;
  esac
  case $kind in
    api)
      [[ $https -gt 0 ]] ||
        errors+=("api: no egress rule to 0.0.0.0/0 on 443 only that excludes private, CGNAT, link-local and loopback ranges")
      ;;
    web)
      [[ $https == 0 ]] || errors+=("web: egress to public addresses is not part of the web kind")
      ;;
  esac

  if [[ ${#errors[@]} -gt 0 ]]; then
    for e in "${errors[@]}"; do
      echo "FAIL: apps/$app/prod: $e" >&2
    done
    status=1
  else
    echo "ok   apps/$app/prod: egress policies${kind:+ ($kind)}"
  fi
done

# ---- Loki ----
loki=$(to_json loki "$OUT/helm/loki.yaml" "$OUT/kustomize/platform_monitoring_loki_config.yaml")
# shellcheck disable=SC2016 # $all, $l, $p are yq variables.
facts=$(q "$loki" '. as $all |
  ($all | map(select(.kind == "StatefulSet" and .metadata.name == "loki")) | .[0].spec.template.metadata.labels // {}) as $l |
  ($all | map(select(.kind == "NetworkPolicy" and .metadata.namespace == "monitoring"
    and ((.spec.policyTypes // []) | any_c(. == "Ingress"))
    and ((.spec.podSelector.matchLabels // {}) | length) > 0
    and ((.spec.podSelector.matchLabels // {}) | to_entries | all_c(. as $e | ($l | .[$e.key]) == $e.value))))) as $p |
  [
    "policies=" + ($p | length | tostring),
    "open=" + ($p | map(.spec.ingress // []) | flatten | map(select((.from // []) | length == 0)) | length | tostring),
    ($p | map(.spec.ingress // []) | flatten | map(.from // []) | flatten | .[] |
      "peer=" + (.podSelector.matchLabels["app.kubernetes.io/name"] // "?"))
  ] | .[]')
policies=0 open=0 peers=""
while IFS='=' read -r key value; do
  case $key in
    policies) policies=$value ;;
    open) open=$value ;;
    peer) peers+=" $value" ;;
  esac
done <<<"$facts"
ok=true
[[ $policies -gt 0 && $open == 0 ]] || ok=false
for p in $peers; do
  case $p in
    alloy | grafana | loki) ;;
    *) ok=false ;;
  esac
done
check "Loki: NetworkPolicy with peers only from Alloy, Grafana, Loki (got:${peers:- none})" "$ok"

exit "$status"
