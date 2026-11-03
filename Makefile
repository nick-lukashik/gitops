# Checks of the repo. CI runs "make verify" on every PR; locally only Docker is needed.
# Tool images are pinned by digest in scripts/lib.sh.
SHELL := bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := verify

.PHONY: verify render static secrets domain kustomize helm images apps netpol kubeconform rules alertmanager alloy shell clean

verify: static render images apps netpol kubeconform rules alertmanager alloy ## all checks

static: secrets domain shell ## checks on files in git

render: kustomize helm ## render manifests into .cache/render

secrets: ## no plain Secret with data
	scripts/check-plain-secrets.sh

domain: ## the domain only in components/settings/settings.yaml
	scripts/check-domain.sh

shell: ## shellcheck and actionlint
	scripts/check-shell.sh

kustomize: ## kustomize build of every kustomization
	scripts/render-kustomize.sh

helm: ## helm template of every Helm Application and the K3s Traefik values
	scripts/render-helm.sh

images: kustomize ## apps/*/prod images only by digest
	scripts/check-images.sh

apps: kustomize ## apps/*/prod follow the service contract: service + api or web
	scripts/check-apps.sh

netpol: render ## prod deny both ways, egress rules of every apps/*/prod, monitoring allow-lists (Loki)
	scripts/check-netpol.sh

kubeconform: render ## kubeconform -strict with CRD schemas
	scripts/check-kubeconform.sh

rules: ## promtool check and unit tests of PrometheusRules
	scripts/check-rules.sh

alertmanager: helm ## amtool check-config of the rendered Alertmanager config
	scripts/check-alertmanager.sh

alloy: ## Alloy syntax and masking test
	scripts/check-alloy.sh

clean: ## remove rendered output (keeps the chart and schema cache)
	rm -rf .cache/render .cache/rules .cache/alertmanager .cache/alloy .cache/netpol
