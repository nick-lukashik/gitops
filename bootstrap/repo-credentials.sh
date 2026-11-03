# shellcheck shell=bash
# Repository access for Argo CD: the only place with repo credentials.
# The repo is public, so this is optional: to read it over HTTPS instead, delete
# this file and its call in install.sh, then remove the secret
# (docs/runbook/access.md, "Repo access of the public gitops").
# Sourced by install.sh, which defines need_secret_file and SECRETS.

REPO_URL=git@github.com:nick-lukashik/gitops.git
REPO_SECRET=repo-gitops

ensure_repo_credentials() {
  if kubectl -n argocd get secret "$REPO_SECRET" >/dev/null 2>&1; then
    echo "repo credentials: $REPO_SECRET exists, skipped"
    return
  fi
  local key
  key=$(need_secret_file argocd-deploy-key argocd-deploy-key)
  kubectl -n argocd create secret generic "$REPO_SECRET" \
    --from-literal=type=git \
    --from-literal=url="$REPO_URL" \
    --from-file=sshPrivateKey="$key" \
    --dry-run=client -o yaml |
    kubectl label --local -f - argocd.argoproj.io/secret-type=repository -o yaml |
    kubectl apply -f - >/dev/null
  echo "repo credentials: $REPO_SECRET created"
}
