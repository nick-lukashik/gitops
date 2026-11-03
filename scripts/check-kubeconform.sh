#!/usr/bin/env bash
# kubeconform -strict on everything rendered by render-kustomize.sh and render-helm.sh.
# Built-in kinds: default schemas; CRDs: datreeio/CRDs-catalog (pinned commit).
# CustomResourceDefinition objects (from upstream charts) are skipped: no schema
# for apiextensions.k8s.io exists in either catalog.
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

mkdir -p "$CACHE/kubeconform"
paths=()
while read -r f; do
  paths+=("$(rel "$f")")
done < <(find "$OUT" -name '*.yaml' | sort)
[[ ${#paths[@]} -gt 0 ]] || fail "nothing rendered; run make render first"

kubeconform -strict -summary -output text -skip CustomResourceDefinition \
  -kubernetes-version "$KUBE_VERSION" \
  -cache /repo/.cache/kubeconform \
  -schema-location default \
  -schema-location "$CRDS_CATALOG/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json" \
  "${paths[@]}" || fail "kubeconform"
