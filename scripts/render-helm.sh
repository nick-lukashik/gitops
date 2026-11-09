#!/usr/bin/env bash
# helm template of every Helm source in platform/**/application.yaml with the
# value files from git, plus the K3s Traefik chart with the HelmChartConfig values.
# Output: .cache/render/helm/<application>.yaml
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

CHARTS=$CACHE/charts
rm -rf "$OUT/helm"
mkdir -p "$OUT/helm" "$CHARTS"

# pull_chart <repo> <chart> <version>: cached .tgz path inside the container.
pull_chart() {
  local tgz=$CHARTS/$2-$3.tgz
  if [[ ! -f $tgz ]]; then
    # GitHub Releases answer 504 for minutes at a time (09.11): retry with a pause.
    local try
    for try in 1 2 3 4 5; do
      helm pull "$2" --repo "$1" --version "$3" --destination "$(rel "$CHARTS")" >/dev/null && break
      [[ $try -lt 5 ]] || fail "helm pull $2 $3"
      echo "helm pull $2 $3 failed, retry $try in $((try * 10)) s" >&2
      sleep $((try * 10))
    done
  fi
  rel "$tgz"
}

# Monitoring CRDs come from another Application; let charts render their monitors.
api_versions=(--api-versions monitoring.coreos.com/v1)

find platform -name application.yaml | sort | while read -r app; do
  # One line per Helm source: name|repo|chart|version|release|namespace|valueFiles(,).
  # shellcheck disable=SC2016 # $app is a yq variable.
  yq -r '. as $app | .spec.sources[]? | select(has("chart")) |
    [$app.metadata.name, .repoURL, .chart, .targetRevision, .helm.releaseName,
     $app.spec.destination.namespace, ((.helm.valueFiles // []) | join(","))] | join("|")' "$app" |
    while IFS='|' read -r name repo chart version release namespace value_files; do
      [[ -n $chart ]] || continue
      args=("${api_versions[@]}")
      for f in ${value_files//,/ }; do
        args+=(--values "/repo/${f#\$values/}")
      done
      tgz=$(pull_chart "$repo" "$chart" "$version")
      helm template "$release" "$tgz" --namespace "$namespace" --include-crds \
        --kube-version "$KUBE_VERSION" "${args[@]}" \
        >"$OUT/helm/$name.yaml" || fail "helm template $name ($chart $version)"
      echo "ok   helm template $name ($chart $version)"
    done
done

# Traefik bundled with K3s: K3s values first, then our HelmChartConfig.
values=$CACHE/traefik-helmchartconfig-values.yaml
yq -r '.spec.valuesContent' platform/traefik-config/helmchartconfig.yaml >"$values"
tgz=$(pull_chart "$K3S_TRAEFIK_REPO" traefik "$K3S_TRAEFIK_CHART_VERSION")
# versionOverride: K3s ships a patched 40.1.x chart that accepts its newer Traefik
# patch release; the upstream chart caps the version, which only affects labels here.
helm template traefik "$tgz" --namespace kube-system --kube-version "$KUBE_VERSION" \
  --values /repo/scripts/k3s-traefik-values.yaml --values "$(rel "$values")" \
  --set versionOverride=v3.7.1 >"$OUT/helm/k3s-traefik.yaml" || fail "helm template k3s traefik"
echo "ok   helm template k3s-traefik (traefik $K3S_TRAEFIK_CHART_VERSION + helmchartconfig)"
