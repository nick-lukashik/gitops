#!/usr/bin/env bash
# The deployed set: for every apps/<service>/prod (templates apps/_* skipped),
# the source commit and the image digest from its kustomization.yaml. The
# deploy annotations are matched by suffix (/source-sha, /source-repo): the
# domain is written only in components/settings.
#   scripts/versions.sh         a table: service, source repo, source sha, digest
#   scripts/versions.sh --env   <SERVICE>_IMAGE=<image>@<digest> lines (e2e/compose.yaml);
#                               apps with no source-sha (third-party) are left out
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

format="table"
case ${1:-} in
  "") ;;
  --env) format="env" ;;
  *) fail "usage: scripts/versions.sh [--env]" ;;
esac

files=()
for f in apps/*/prod/kustomization.yaml; do
  case $f in apps/_*) continue ;; esac
  files+=("/repo/$f")
done
[[ ${#files[@]} -gt 0 ]] || fail "no apps/*/prod/kustomization.yaml"

# One tab-separated line per service: folder, source repo, source sha, image,
# digest; "-" where a key is missing.
rows=$(yq -N -r '[
  (filename | split("/") | .[-3]),
  ((.commonAnnotations // {}) | to_entries | map(select(.key | test("/source-repo$"))) | .[0].value // "-"),
  ((.commonAnnotations // {}) | to_entries | map(select(.key | test("/source-sha$"))) | .[0].value // "-"),
  ((.images // []) | .[0].name // "-"),
  ((.images // []) | .[0].digest // "-")
] | @tsv' "${files[@]}")

if [[ $format == env ]]; then
  while IFS=$'\t' read -r service _ sha image digest; do
    # The rule of smoke.yml: no deploy annotation, not one of our services.
    [[ $sha != - ]] || continue
    [[ $image != - && $digest != - ]] || fail "apps/$service/prod: source-sha but no image digest"
    printf '%s_IMAGE=%s@%s\n' "$(tr 'a-z-' 'A-Z_' <<<"$service")" "$image" "$digest"
  done <<<"$rows"
  exit 0
fi

printf '%-20s %-32s %-40s %s\n' SERVICE SOURCE-REPO SOURCE-SHA DIGEST
while IFS=$'\t' read -r service repo sha _ digest; do
  printf '%-20s %-32s %-40s %s\n' "$service" "$repo" "$sha" "$digest"
done <<<"$rows"
