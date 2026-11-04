# bootstrap

Run once on a new cluster: `install.sh` ([README](../README.md#step-4-bootstrap-of-the-cluster), step 4).

| File | What |
|---|---|
| `install.sh` | PriorityClasses, the Sealed Secrets key and controller, Argo CD, AppProjects, `root` |
| `root.yaml` | Application `root` on `platform/` |
| `sealed-secrets.crt` | the public certificate for `kubeseal --cert`; the owner adds it from Bitwarden `sealed-secrets-crt` |
