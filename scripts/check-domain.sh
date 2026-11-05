#!/usr/bin/env bash
# The production domain is written only in components/settings/settings.yaml.
# Label and annotation keys under the "<domain>/" prefix (source-sha and
# source-repo of the deploy PR, the kind pod label, also as the key of a selector)
# are names, not settings, and are ignored.
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

domain=$(yq -r '.domain' components/settings/settings.yaml)
[[ -n $domain && $domain != null ]] || fail "no domain in components/settings/settings.yaml"

found=$(grep -rIF --include='*.yaml' --include='*.yml' --include='*.alloy' \
  --exclude-dir=.cache --exclude-dir=.git -- "$domain" . |
  grep -v '^./components/settings/settings.yaml:' |
  grep -vE "^[^:]+:[[:space:]]*(${domain//./\\.}/[a-z0-9-]+:|- key: ${domain//./\\.}/[a-z0-9-]+$)" || true)
if [[ -n $found ]]; then
  printf 'FAIL: domain %s outside components/settings/settings.yaml:\n%s\n' "$domain" "$found" >&2
  exit 1
fi
echo "ok   domain only in components/settings/settings.yaml"
