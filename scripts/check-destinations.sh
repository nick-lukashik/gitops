#!/usr/bin/env bash
# Every Argo CD Application (bootstrap/root.yaml, platform/**/application.yaml,
# platform/argocd/projects.yaml and the template of the ApplicationSet
# apps-prod) sends its resources to a server and namespace listed in the
# destinations of its AppProject. Argo CD refuses any other Application, one
# without a namespace too ("do not match any of the allowed destinations"),
# and root then waits for it forever.
# Written for bash 3.2 (macOS) too: no associative arrays.
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

apps=(bootstrap/root.yaml platform/argocd/projects.yaml platform/argocd/apps-prod.yaml)
while IFS= read -r f; do
  apps+=("$f")
done < <(find platform -name application.yaml | sort)

# "<project> <server> <namespace pattern>" for every destination of every AppProject.
# shellcheck disable=SC2016 # $p is a yq variable.
dests=$(yq -r 'select(.kind == "AppProject") | .metadata.name as $p | (.spec.destinations // [])[] | $p + " " + .server + " " + .namespace' projects/*.yaml)
# "<file> <project> <server> <namespace>"; "-" for a missing namespace.
# shellcheck disable=SC2016 # $s is a yq variable.
lines=$(yq -r '(.spec.template.spec // .spec) as $s | [filename, $s.project, $s.destination.server, ($s.destination.namespace // "-")] | join(" ")' "${apps[@]}")

n=0
while read -r file project server ns; do
  grep -q "^$project " <<<"$dests" || fail "$file: project '$project' has no destinations in projects/"
  [[ -n $ns && $ns != - ]] || fail "$file: destination without a namespace; project $project allows only listed namespaces"
  allowed=no
  while read -r p s pattern; do
    # Project namespaces may be globs, so the right side stays unquoted.
    # shellcheck disable=SC2053
    if [[ $p == "$project" && $s == "$server" && $ns == $pattern ]]; then
      allowed=yes
    fi
  done <<<"$dests"
  [[ $allowed == yes ]] || fail "$file: namespace $ns on $server is not a destination of project $project"
  n=$((n + 1))
done <<<"$lines"
echo "ok   $n Applications go to destinations of their AppProject"
