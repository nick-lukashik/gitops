#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# Bootstrap of a new cluster (README, step 4): Sealed Secrets with the key from
# Bitwarden, Argo CD, repo access, AppProjects and Application "root".
# Everything else comes from git through Argo CD.
#
# Re-running changes nothing: every step is skipped when its result exists.
# Not needed after a reboot: the Sealed Secrets key stays in etcd.
#
# Needs: kubectl with the new cluster as current context, helm, openssl,
# Bitwarden unlocked (export BW_SESSION="$(bw unlock --raw)"), and the infra
# repo next to gitops (or INFRA_DIR=<path>). Secrets go only to
# $TMPDIR/nl-secrets (mode 600) and are removed on exit; nothing is printed.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
INFRA_DIR=${INFRA_DIR:-$ROOT/../infra}
SECRETS=$INFRA_DIR/scripts/secrets.sh

die() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -x $SECRETS ]]; then
    "$SECRETS" clean
  fi
}
trap cleanup EXIT

for cmd in kubectl helm openssl awk; do
  command -v "$cmd" >/dev/null 2>&1 || die "missing command: $cmd"
done
[[ -x $SECRETS ]] || die "not found: $SECRETS (set INFRA_DIR)"

# need_secret_file <bitwarden item> <file name>: prints the path of a 600 file.
need_secret_file() {
  "$SECRETS" get "$1" "$2"
}

# chart_version <application.yaml> <chart>: targetRevision pinned in git.
chart_version() {
  awk -v chart="$2" '
    $1 == "chart:" && $2 == chart { found = 1 }
    found && $1 == "targetRevision:" { print $2; exit }
  ' "$1"
}

# helm_install <release> <namespace> <repo> <chart> <application.yaml> <values>...
# Installs once; afterwards Argo CD manages the release from git.
helm_install() {
  local release=$1 ns=$2 repo=$3 chart=$4 app=$5
  shift 5
  local version
  version=$(chart_version "$app" "$chart")
  [[ -n $version ]] || die "no targetRevision for $chart in $app"
  if helm -n "$ns" status "$release" >/dev/null 2>&1; then
    echo "$release: release exists, skipped (Argo CD manages upgrades)"
    return
  fi
  local values=() f
  for f in "$@"; do
    values+=(--values "$f")
  done
  helm upgrade --install "$release" "$chart" --repo "$repo" --version "$version" \
    --namespace "$ns" --create-namespace "${values[@]}" --wait --timeout 10m
  echo "$release: installed $chart $version"
}

fingerprint() {
  openssl x509 -noout -fingerprint -sha256 -in "$1"
}

kubectl get --raw /readyz >/dev/null || die "cluster is not reachable with the current kubectl context"

# 1. PriorityClasses used by the pods below (platform/policies manages them later).
if kubectl get -f "$ROOT/platform/policies/priorityclasses.yaml" >/dev/null 2>&1; then
  echo "priority classes: present, skipped"
else
  kubectl apply -f "$ROOT/platform/policies/priorityclasses.yaml" >/dev/null
  echo "priority classes: created"
fi

# 2. Sealed Secrets key pair (RSA 4096, 10 years) from Bitwarden.
if [[ -n $(kubectl -n kube-system get secret -l sealedsecrets.bitnami.com/sealed-secrets-key=active -o name) ]]; then
  echo "sealed-secrets key: present, skipped"
else
  key=$(need_secret_file sealed-secrets-key sealed-secrets.key)
  crt=$(need_secret_file sealed-secrets-crt sealed-secrets.crt)
  if [[ -f $ROOT/bootstrap/sealed-secrets.crt ]] &&
    [[ $(fingerprint "$crt") != "$(fingerprint "$ROOT/bootstrap/sealed-secrets.crt")" ]]; then
    die "Bitwarden sealed-secrets-crt differs from bootstrap/sealed-secrets.crt"
  fi
  kubectl -n kube-system create secret tls sealed-secrets-key --cert="$crt" --key="$key" \
    --dry-run=client -o yaml |
    kubectl label --local -f - sealedsecrets.bitnami.com/sealed-secrets-key=active -o yaml |
    kubectl apply -f - >/dev/null
  echo "sealed-secrets key: created"
fi

# 3. Sealed Secrets controller (keyrenewperiod=0) and Argo CD 3.x, versions from git.
helm_install sealed-secrets kube-system https://bitnami.github.io/sealed-secrets sealed-secrets \
  "$ROOT/platform/sealed-secrets/application.yaml" \
  "$ROOT/platform/sealed-secrets/values.yaml"
helm_install argocd argocd https://argoproj.github.io/argo-helm argo-cd \
  "$ROOT/platform/argocd/application.yaml" \
  "$ROOT/components/settings/settings.yaml" \
  "$ROOT/platform/argocd/values.yaml"

# 4. Repo access with deploy key argocd-deploy-key.
# shellcheck source=repo-credentials.sh
source "$ROOT/bootstrap/repo-credentials.sh"
ensure_repo_credentials

# 5. AppProjects (root belongs to "platform"), then Application "root" on platform/.
if kubectl -n argocd get appproject platform >/dev/null 2>&1; then
  echo "projects: present, skipped"
else
  kubectl apply -k "$ROOT/projects" >/dev/null
  echo "projects: created"
fi
if kubectl -n argocd get application root >/dev/null 2>&1; then
  echo "root: present, skipped"
else
  kubectl apply -f "$ROOT/bootstrap/root.yaml" >/dev/null
  echo "root: created"
fi

echo "Next: kubectl -n argocd get applications (root must become Synced)."
