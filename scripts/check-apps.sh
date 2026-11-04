#!/usr/bin/env bash
# Service folders follow the runtime contract (apps/README.md). For every
# apps/<app>/prod except the third-party apps below:
# - components: components/service first, then exactly one of components/api or
#   components/web, optionally components/subdomain, or components/internal for an
#   api without a route, nothing else;
# - images: one entry ghcr.io/nick-lukashik/<name> with a digest, no newName or
#   newTag; commonAnnotations source-sha and source-repo (deploy PR convention);
# - the build: Deployment <name> on that image (no replicas: a HorizontalPodAutoscaler
#   with minReplicas >= 2 and a PodDisruptionBudget own them), its ConfigMap <name>-config-<hash>
#   rendered, a route with a real host and the middlewares real-ip@file and
#   body-limit@file on api routes only, and the parts of its kind.
# Also: middleware body-limit of the Traefik file provider caps request bodies
# at 1 MiB (service runtime contract, "Request size").
# <name> is the folder name without the leading "_" of the templates. Both
# templates must exist, and the ApplicationSet must keep skipping apps/_*.
# Written for bash 3.2 (macOS) too: no associative arrays.
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# Not built from the service image contract (a third-party image with its own
# manifests), space-separated: " <name> <name> ". None today.
THIRD_PARTY=" "
TEMPLATES=(_example-web _example-api)
REGISTRY=ghcr.io/nick-lukashik
C=../../../components

for t in "${TEMPLATES[@]}"; do
  [[ -f apps/$t/prod/kustomization.yaml ]] || fail "template apps/$t/prod is missing"
done
excluded=$(yq -r '.spec.generators[].git.directories[] | select(.exclude == true) | .path' \
  platform/argocd/apps-prod.yaml)
[[ $excluded == "apps/_*/prod" ]] || fail "ApplicationSet apps-prod must exclude apps/_*/prod (got '$excluded')"

limit=$(yq -r '.spec.valuesContent | from_yaml | .providers.file.content | from_yaml |
  .http.middlewares["body-limit"].buffering.maxRequestBodyBytes // ""' platform/traefik-config/helmchartconfig.yaml)
[[ $limit == 1048576 ]] || fail "Traefik middleware body-limit must set buffering.maxRequestBodyBytes: 1048576, got '$limit'"

status=0
for file in apps/*/prod/kustomization.yaml; do
  app=${file#apps/}
  app=${app%%/*}
  if [[ $THIRD_PARTY == *" $app "* ]]; then
    echo "skip apps/$app/prod: third-party, own manifests"
    continue
  fi
  name=${app#_}
  rendered=$OUT/kustomize/apps_${app}_prod.yaml
  [[ -f $rendered ]] || fail "no $rendered; run make render first"

  errors=()

  # Source kustomization: one key=value line per fact.
  components="" images="" image_name="" image_digest="" image_extra="" source_keys=""
  while IFS='=' read -r key value; do
    case $key in
      components) components=$value ;;
      images) images=$value ;;
      image_name) image_name=$value ;;
      image_digest) image_digest=$value ;;
      image_extra) image_extra=$value ;;
      source_keys) source_keys=$value ;;
    esac
  done < <(yq -r '
    "components=" + ((.components // []) | join(" ")),
    "images=" + ((.images // []) | length | tostring),
    "image_name=" + (.images[0].name // ""),
    "image_digest=" + (.images[0].digest // ""),
    "image_extra=" + ((.images[0] // {}) | keys | map(select(. != "name" and . != "digest")) | join(" ")),
    "source_keys=" + ((.commonAnnotations // {}) | keys | map(select(test("/source-(sha|repo)$"))) | length | tostring)
  ' "/repo/$file")

  kind=""
  internal=0
  first=1
  for c in $components; do
    if [[ $first == 1 ]]; then
      [[ $c == "$C/service" ]] || errors+=("components must start with $C/service, got $c")
      first=0
      continue
    fi
    case $c in
      "$C/api" | "$C/web")
        [[ -z $kind ]] || errors+=("more than one of $C/api and $C/web")
        kind=${c##*/}
        ;;
      "$C/subdomain") ;;
      "$C/internal") internal=1 ;;
      *) errors+=("unexpected component $c (after service: api or web, and subdomain or internal)") ;;
    esac
  done
  [[ $first == 0 ]] || errors+=("components must start with $C/service")
  [[ -n $kind ]] || errors+=("needs exactly one of $C/api or $C/web")
  if [[ $internal == 1 ]]; then
    [[ $kind == api ]] || errors+=("$C/internal is for an api")
    [[ " $components " != *" $C/subdomain "* ]] || errors+=("$C/internal has no host: drop $C/subdomain")
  fi

  [[ $images == 1 ]] || errors+=("images: expected one entry, found $images")
  [[ $image_name == "$REGISTRY/$name" ]] || errors+=("images[0].name must be $REGISTRY/$name, got '$image_name'")
  [[ $image_digest =~ ^sha256:[0-9a-f]{64}$ ]] || errors+=("images[0].digest must be sha256:<64 hex>")
  [[ -z $image_extra ]] || errors+=("images[0] may hold only name and digest, found: $image_extra")
  [[ $source_keys == 2 ]] || errors+=("commonAnnotations need <domain>/source-sha and <domain>/source-repo")

  # Rendered build.
  deployment="" image="" config_ref="" next_cache="" host="" match="" middlewares="" smoke_paths="" job="" servicemonitor="" replicas="" hpa="" pdb=""
  configmaps=" "
  while IFS='=' read -r key value; do
    case $key in
      deployment) deployment+=${deployment:+,}$value ;;
      image) image=$value ;;
      config_ref) config_ref=$value ;;
      next_cache) next_cache=$value ;;
      configmap) configmaps+="$value " ;;
      host) host+=${host:+,}$value ;;
      match) match=$value ;;
      middlewares) middlewares=$value ;;
      job) job+=${job:+,}$value ;;
      servicemonitor) servicemonitor+=${servicemonitor:+,}$value ;;
      replicas) replicas=$value ;;
      hpa) hpa+=${hpa:+,}$value ;;
      pdb) pdb+=${pdb:+,}$value ;;
    esac
  # In yq "," binds looser than "|": every list after a pipe is in parentheses.
  done < <(yq -N -r '
    (select(.kind == "Deployment" and .metadata.labels["app.kubernetes.io/component"] == "server") | (
      ("deployment=" + .metadata.name),
      (.spec.template.spec.containers[] | select(.name == "app") | (
        ("image=" + .image),
        ("config_ref=" + (.envFrom[0].configMapRef.name // "")),
        ("next_cache=" + ((.volumeMounts // []) | map(select(.mountPath == "/app/.next/cache")) | length | tostring))
      ))
    )),
    (select(.kind == "ConfigMap") | "configmap=" + .metadata.name),
    (select(.kind == "IngressRoute") | (
      ("host=" + (.metadata.annotations["nl-gitops/host"] // "")),
      ("match=" + .spec.routes[0].match),
      ("middlewares=" + ((.spec.routes[0].middlewares // []) | map(.name) | join(" ")))
    )),
    (select(.kind == "Job") | "job=" + .metadata.name + " " + ((.spec.template.spec.containers[0].command // []) | join(" "))),
    (select(.kind == "ServiceMonitor") | "servicemonitor=" + .metadata.name),
    (select(.kind == "Deployment" and .metadata.labels["app.kubernetes.io/component"] == "server") | "replicas=" + ((.spec.replicas // "none") | tostring)),
    (select(.kind == "HorizontalPodAutoscaler") | "hpa=" + .spec.scaleTargetRef.name + " " + (.spec.minReplicas | tostring)),
    (select(.kind == "PodDisruptionBudget") | "pdb=" + .metadata.name)
  ' "$(rel "$rendered")")

  smoke_paths=$(yq -N 'select(.kind == "IngressRoute") | .metadata.annotations["nl-gitops/smoke-paths"] // ""' "$(rel "$rendered")")
  [[ -n $smoke_paths || $internal == 1 ]] || errors+=("build: nl-gitops/smoke-paths must list read-only HTTP paths")
  for smoke_path in $smoke_paths; do
    [[ $smoke_path == /* && $smoke_path != //* ]] || errors+=("build: invalid smoke path '$smoke_path'")
  done

  [[ $deployment == "$name" ]] || errors+=("build: expected one Deployment $name, got '$deployment'")
  # Two replicas at least: the autoscaler owns the count, the Deployment sets none.
  [[ $replicas == none ]] || errors+=("build: the Deployment must not set replicas (the HorizontalPodAutoscaler owns them), got '$replicas'")
  if [[ $hpa =~ ^$name\ ([0-9]+)$ ]] && ((BASH_REMATCH[1] >= 2)); then :; else
    errors+=("build: needs HorizontalPodAutoscaler $name with minReplicas >= 2, got '$hpa'")
  fi
  [[ $pdb == "$name" ]] || errors+=("build: needs PodDisruptionBudget $name, got '$pdb'")
  [[ $image =~ ^${REGISTRY//./\\.}/${name}@sha256:[0-9a-f]{64}$ ]] ||
    errors+=("build: image must be $REGISTRY/$name@sha256:<digest>, got '$image'")
  [[ $config_ref == "$name"-config-* && $configmaps == *" $config_ref "* ]] ||
    errors+=("build: envFrom needs ConfigMap $name-config from a configMapGenerator, got '$config_ref'")
  if [[ $internal == 1 ]]; then
    [[ -z $host ]] || errors+=("build: an internal api has no IngressRoute, got '$host'")
  else
    [[ $host =~ ^[a-z0-9.-]+\.[a-z]+$ && $match == "Host(\`$host\`)" ]] ||
      errors+=("build: one IngressRoute whose nl-gitops/host annotation is its Host(), got '$host' / '$match'")
    [[ " $middlewares " == *" real-ip@file "* ]] ||
      errors+=("build: the IngressRoute needs middleware real-ip@file, got '$middlewares'")
  fi
  # body-limit (Traefik buffering) on api routes only: it also buffers whole
  # responses, which would break streamed HTML on web routes.
  if [[ $internal == 1 ]]; then :
  elif [[ $kind == api ]]; then
    [[ " $middlewares " == *" body-limit@file "* ]] || errors+=("build: an api IngressRoute needs body-limit@file, got '$middlewares'")
  else
    [[ " $middlewares " != *" body-limit@file "* ]] || errors+=("build: a web IngressRoute must not use body-limit@file (it buffers responses)")
  fi
  case $kind in
    api)
      [[ $job == "$name-migrate node dist/db/migrate.js" ]] || errors+=("build: api needs Job $name-migrate, got '$job'")
      [[ $servicemonitor == "$name" ]] || errors+=("build: api needs ServiceMonitor $name, got '$servicemonitor'")
      ;;
    web)
      [[ $next_cache == 1 ]] || errors+=("build: web needs the /app/.next/cache volume")
      [[ -z $job$servicemonitor ]] || errors+=("build: web has no migrate Job and no ServiceMonitor")
      ;;
  esac

  if [[ ${#errors[@]} -gt 0 ]]; then
    for e in "${errors[@]}"; do
      echo "FAIL: apps/$app/prod: $e" >&2
    done
    status=1
  else
    if [[ $internal == 1 ]]; then echo "ok   apps/$app/prod: $kind $name, internal (no route)"
    else echo "ok   apps/$app/prod: $kind $name, https://$host"; fi
  fi
done
exit "$status"
