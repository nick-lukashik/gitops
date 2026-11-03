#!/usr/bin/env bash
# Every image in apps/*/prod is pinned by digest (name@sha256:<64 hex>), never a tag only.
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

status=0
for file in "$OUT"/kustomize/apps_*_prod.yaml; do
  [[ -f $file ]] || fail "no rendered apps/*/prod; run make render first"
  app=$(basename "$file" .yaml)
  while read -r image; do
    [[ -z $image ]] && continue
    if [[ ! $image =~ @sha256:[0-9a-f]{64}$ ]] || [[ $image == *:latest* ]]; then
      echo "FAIL: $app: image not pinned by digest: $image" >&2
      status=1
    fi
  done < <(yq -N -r '.. | select(type == "!!map" and has("image")) | .image' "$(rel "$file")")
  [[ $status -eq 0 ]] && echo "ok   images by digest: $app"
done
exit "$status"
