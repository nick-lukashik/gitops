#!/usr/bin/env bash
# kustomize build of every kustomization.yaml (components are built through their users).
# Output: .cache/render/kustomize/<dir with / as _>.yaml
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

rm -rf "$OUT/kustomize"
mkdir -p "$OUT/kustomize"

find . -name kustomization.yaml -not -path './.cache/*' -not -path './components/*' | sort |
  while read -r file; do
    dir=${file%/kustomization.yaml}
    dir=${dir#./}
    [[ $dir == . || $dir == kustomization.yaml ]] && dir=.
    out=$OUT/kustomize/${dir//\//_}.yaml
    kustomize build "$dir" >"$out" || fail "kustomize build $dir"
    echo "ok   kustomize build $dir"
  done
