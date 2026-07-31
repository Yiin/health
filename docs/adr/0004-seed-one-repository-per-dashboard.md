---
status: accepted
---

# Seed one repository per dashboard

The private `Yiin/dashboards` repository owns the clean platform base. Each product gets a private application repository and deployed source tree.

## Base ownership

Create a protected `platform` branch in `Yiin/dashboards`. Start it from commit `84f777b40aacba56a0b01c18ba1520bd5668051a`.

Add only reviewed, product-neutral platform changes to this branch. Do not add MB or Health features.

Publish every seed as an immutable annotated tag. Tags use `base-YYYY.MM.N`, starting with `base-2026.07.1`.

A tag names the release. Its commit is the authoritative seed identity.

Keep the current `main` branch unchanged until MB runs from its own repository. Tag that state as `legacy-mb-shared`.

After MB cutover, make `platform` the default branch. Do not rewrite the former MB history.

## Repository contract

Each dashboard uses a private repository named `Yiin/dashboard-<slug>`.

Health uses `Yiin/dashboard-health`. MB uses `Yiin/dashboard-mb`.

The product's default branch is `main`. Its `origin` points only to its product repository.

Seed a product by copying the complete history through one exact base tag. Do not use a GitHub template snapshot.

Each product repository records this immutable seed data in `dashboard.seed.json`:

```json
{
  "schemaVersion": 1,
  "baseRepository": "Yiin/dashboards",
  "baseTag": "base-2026.07.1",
  "baseCommit": "84f777b40aacba56a0b01c18ba1520bd5668051a",
  "product": "health"
}
```

The initial product commit adds the seed manifest, Wayfinder map, dashboard rules, and selected surface configuration.

## Repository roles

One dashboard instance contains two Git repositories with different roles.

The application repository contains source code, migrations, tests, and deployment scripts. Operators deploy it.

The workspace repository contains dashboard documents and agent-managed product data. The dashboard agent can change it.

The agent cannot change the application repository, state directory, service files, or deployment configuration.

Application changes reach production only through a pushed product commit and the deployment process.

## Server layout

Every instance uses this layout:

```text
/srv/dashboards/<slug>/
  src/        application repository
  workspace/  agent workspace repository
  state/      platform state and logs
```

`dashboard@<slug>.service` runs `/srv/dashboards/<slug>/src/apps/server/dist/bin.mjs`.

The service keeps `workspace/` as its working directory. It keeps platform state under `state/`.

Each product deploy builds its own source and restarts only its own service.

Shared authentication homes, File Browser, pairing, DPoP, Caddy tsnet, dnsmasq, and workspace autosave remain platform services.

## Provisioning inputs

The spin-up flow asks these questions before it plans a dashboard:

- What are the slug, display name, and purpose?
- Which product surfaces exist, and which surface opens first?
- What data can each surface read and write?
- Which actions need explicit confirmation?
- Which domain terms and records belong in the Wayfinder map?
- Which harness and default model apply?
- Does the dashboard need the shared File Browser?
- Which tailnet hostname should Caddy use?
- What private product repository should receive the seed?
- Does version one import existing data?
- What storage, backup, and retention limits apply?

Recommended defaults use `Yiin/dashboard-<slug>`, `main`, shared auth, File Browser enabled, and no data migration.

The accepted answers become the Wayfinder map and product `AGENTS.md`. Provisioning does not replace product planning.

## Provisioning behavior

The platform provisioner accepts `--repo`, `--ref`, and `--seed-commit`.

It performs these steps:

1. Verify that the seed tag and commit exist on the private base remote.
2. Verify that the product repository exists and is private.
3. Clone the product repository into a temporary release directory.
4. Verify `origin`, `dashboard.seed.json`, the selected ref, and a clean worktree.
5. Install locked dependencies and run the product build.
6. Move the verified source into `<instance>/src`.
7. Create `workspace/`, `state/`, instance configuration, and scoped File Browser access.
8. Start only `dashboard@<slug>.service`.
9. Verify health, pairing, streaming Chat, restart, and tailnet access.

The provisioner fails before service changes when any identity or build check fails.

Dry-run output names the repository, ref, commit, paths, service, port, hostname, modules, and planned changes.

The platform records the deployed commit and seed commit in instance state. The status endpoint returns both IDs.

## MB extraction

Use this order:

1. Preserve `Yiin/dashboards:main` and `/srv/dashboards/src`.
2. Publish commit `84f777b40aacba56a0b01c18ba1520bd5668051a` on `platform` and create the first base tag.
3. Add per-instance source support without changing existing MB services.
4. Create `Yiin/dashboard-mb` from the current MB history.
5. Build MB in `/srv/dashboards/mb/src` against a copy of its state.
6. Verify MB behavior, migrations, pairing, Chat, backup, deploy, and rollback.
7. Change only `dashboard@mb.service` to the MB source tree.
8. Move acceptance to its own disposable product repository or remove it.
9. Stop using `/srv/dashboards/src` only after both shared consumers leave it.
10. Make `platform` the default branch in `Yiin/dashboards`.

A clean platform build never opens the existing MB state database.

## Product updates

Products do not rebase on T3 Code or merge the platform branch routinely.

A platform fix creates a new immutable base tag, changelog, migration note, and tested patch range.

An update helper creates a product branch and pull request. It applies only the selected platform commits.

The pull request updates `dashboard.seed.json` after tests pass. A failed update leaves production unchanged.

Each product can skip a platform release. Security fixes can define a required deadline without automatic deployment.

Product code never flows into the platform branch directly. A maintainer first extracts and reviews a product-neutral change.

## Deployment and rollback

Deployment uses a clean product commit that exists on `origin`. It never deploys an unpushed worktree.

Builds happen before the running source link changes. The deployer retains the former release and commit.

Rollback restores the former release, runs only compatible rollback steps, and restarts one product service.

State migrations need a forward-compatible rollback plan. An irreversible migration blocks deployment without a tested restore path.

Application source does not need file backup because the private remote and commit identity restore it.

Workspace, state, databases, source objects, instance configuration, and secret references still require backup.

## Rejected options

A new base repository would duplicate ownership. `Yiin/dashboards` already owns the private dashboard platform.

One branch per product would keep histories and deployments coupled.

A template snapshot would hide the exact inherited history and make selective fixes harder.

Rewriting `Yiin/dashboards:main` before MB extraction would create avoidable service and history risk.

Routine upstream rebases would break the accepted detached platform contract.

## Consequences

The service template and provisioner need per-instance source support.

The current shared deploy script must become a per-product deployer.

The current backup script must exclude every application `src/`, not only `/srv/dashboards/src`.

MB extraction must finish before the shared source tree can retire.

New dashboards gain isolated code, releases, failures, and rollback.
