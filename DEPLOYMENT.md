# How this deploys

CI builds and pushes an image. **ArgoCD deploys.** CI holds no cluster
credentials — that is the point of the split.

- push to `main` → `dev-push.yml` builds `paperclip` into
  `registry.mareanalytica.com/mare-dev/`
- tag `v*`       → `prod-tag.yml`, the release build
- ArgoCD watches `MareAnalytica/gitops` → `apps/dev/paperclip.yaml`, which points
  back at this repo's `kube/overlays/dev`

The manifests still live here. Only the *act* of applying them moved.

## What changed and why
This repo ran `kubectl apply` from a runner inside the cluster (`_deploy.yml`,
now deleted), so CI could write to the cluster and nothing described what was
actually deployed. Under the Jove model the cluster pulls its own desired state
and nothing pushes into it.

Every `runs-on:` moved from `arc-runner-set` to `liquidmetal` — not just the
build jobs. The old scale set died with the previous cluster, so the test, PR,
e2e and release workflows were all pointing at runners that no longer exist.
The scale set now runs on the prod cluster under the helm release `liquidmetal`
(it was briefly `liquidmetal-dev` on the dev cluster).

## Target cluster
The **Liquid Metal** dev cluster (`liquidmetal-dev` control plane +
`liquidscale-dev`), not the aflabox clusters.

## Still to do before this runs green
- the image has never been built into Harbor; `registry.mareanalytica.com` died
  with the previous cluster
- `paperclip-dev`'s database needs restoring from the backup on Jove `io`
  (`paperclip.zst` — `pg_restore` as role `paperclip`, not `postgres`)
- `paperclip-dev` held 5 secrets in the old cluster; they are in the backup
