#!/usr/bin/env bash
# Lints bootstrap/ and scripts/ with shellcheck, the workflows with actionlint.
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

shellcheck -x bootstrap/install.sh bootstrap/repo-credentials.sh scripts/*.sh || fail "shellcheck"
echo "ok   shellcheck"
actionlint -color=false .github/workflows/*.yml || fail "actionlint"
echo "ok   actionlint"
