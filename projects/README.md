# projects

AppProjects. `bootstrap/install.sh` applies them before `root`; from then on Application `projects` manages them.

| AppProject | Allowed |
|---|---|
| `platform` | the system namespaces and `prod` (quotas, policies), cluster resources, the `gitops` repo and the Helm repos of the platform |
| `prod` | namespace `prod` only, no cluster resources, no ResourceQuota or LimitRange, the `gitops` repo only |
| `default` | nothing: the built-in project is closed |

Notification subscriptions are AppProject annotations: failures of every application go to the topic "Alerts", deploys of `prod` services to "Deploys". The recipients come from `components/settings/settings.yaml`.
