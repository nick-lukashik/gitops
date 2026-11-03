# shellcheck shell=bash disable=SC2034
# Shared part of the make verify scripts. Every tool runs in a container pinned
# by digest, so CI and a laptop give the same result; the host needs Docker only.
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
CACHE=$REPO/.cache
OUT=$CACHE/render

IMG_HELM=docker.io/alpine/helm:3.22.1@sha256:8191701ad1f82ee3695c87211fcbfe6d7b1bb7df92ac1c8de9ccdb0995a6a2c1
IMG_KUSTOMIZE=registry.k8s.io/kustomize/kustomize:v5.8.3@sha256:429eda4a1c76a7de458d0c4ca3ded9b5d764899ff6bdaeccc1d98b1b6ee873e4
IMG_KUBECONFORM=ghcr.io/yannh/kubeconform:v0.8.0@sha256:faffaf43f95aa6425306e1ab8d6fcad72acb9049158f38e574c085ea1ec0f64e
IMG_YQ=docker.io/mikefarah/yq:4.54.1@sha256:4b3d9475d65571d28cbb19544d3820ec2945e4c8b2f18279394282b8dc3a592e
IMG_PROMETHEUS=docker.io/prom/prometheus:v3.15.1@sha256:fa3302279710be2f21a8301ec17a8b4f2301fd829bd113839b3b6b02b6f191a2
IMG_ALERTMANAGER=docker.io/prom/alertmanager:v0.34.2@sha256:39d8bb3966c694a124428a3a88fbcffd40bd069129ecd47c059f8a3f17c55f3b
IMG_ALLOY=docker.io/grafana/alloy:v1.21.3@sha256:8ab871206bd2d8f89277f53abffee5f452a293980788d52f85fa183a87a505a4
IMG_SHELLCHECK=docker.io/koalaman/shellcheck:v0.11.0@sha256:61862eba1fcf09a484ebcc6feea46f1782532571a34ed51fedf90dd25f925a8d
IMG_ACTIONLINT=docker.io/rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667

# Kubernetes version of K3s (infra node/k3s/install.sh: v1.36.5+k3s1).
KUBE_VERSION=1.36.0
# Traefik chart bundled with that K3s release (manifests/traefik.yaml of k3s-io/k3s).
K3S_TRAEFIK_REPO=https://traefik.github.io/charts
K3S_TRAEFIK_CHART_VERSION=40.1.0
# CRD JSON schemas for kubeconform, pinned to a commit of datreeio/CRDs-catalog.
CRDS_CATALOG=https://raw.githubusercontent.com/datreeio/CRDs-catalog/27233a506de0085e71c7f9702597806a7f95eb24

# run <entrypoint or ""> <image> <args...>: the repo is mounted at /repo (cwd).
# No stdin: callers read file lists in while loops.
run() {
  local entrypoint=$1 image=$2
  shift 2
  local args=(--rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$REPO:/repo" -w /repo)
  if [[ -n $entrypoint ]]; then
    args+=(--entrypoint "$entrypoint")
  fi
  # The kustomize image is published for amd64 only.
  if [[ $image == "$IMG_KUSTOMIZE" ]]; then
    args+=(--platform linux/amd64)
  fi
  docker run "${args[@]}" "$image" "$@" </dev/null
}

helm() { run "" "$IMG_HELM" "$@"; }
kustomize() { run "" "$IMG_KUSTOMIZE" "$@"; }
kubeconform() { run "" "$IMG_KUBECONFORM" "$@"; }
yq() { run "" "$IMG_YQ" "$@"; }
promtool() { run /bin/promtool "$IMG_PROMETHEUS" "$@"; }
amtool() { run /bin/amtool "$IMG_ALERTMANAGER" "$@"; }
alloy() { run /bin/alloy "$IMG_ALLOY" "$@"; }
shellcheck() { run "" "$IMG_SHELLCHECK" "$@"; }
actionlint() { run "" "$IMG_ACTIONLINT" "$@"; }

# rel <absolute path>: path inside the container (/repo/...).
rel() {
  printf '/repo/%s' "${1#"$REPO"/}"
}

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

cd "$REPO"
