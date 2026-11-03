#!/usr/bin/env bash
# No plain Kubernetes Secret with data or stringData in git: only SealedSecret
# (or a kustomize secretGenerator over a public file, like the Cloudflare CA).
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

list_files() {
  if git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$REPO" ls-files --cached --others --exclude-standard -- '*.yaml' '*.yml'
  else
    find . \( -name '*.yaml' -o -name '*.yml' \) -not -path './.cache/*' | sed 's#^\./##' | sort
  fi
}

paths=()
while read -r f; do
  # Tracked but deleted in the working tree (an uncommitted removal).
  [[ -f $f ]] || continue
  paths+=("/repo/$f")
done < <(list_files)

found=$(yq ea -N -r 'select(.kind == "Secret" and (has("data") or has("stringData"))) |
  filename + ": " + (.metadata.name // "?")' "${paths[@]}")
if [[ -n $found ]]; then
  printf 'FAIL: plain Secret with data in git (seal it, SECRETS.md):\n%s\n' "$found" >&2
  exit 1
fi
echo "ok   no plain Secret with data (${#paths[@]} files)"
