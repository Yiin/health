---
status: accepted
---

# Release Health with evidence and a reversible cutover

Health replaces the current site only after one recorded acceptance run passes every blocking gate. The hostname switch remains reversible.

## Release artifact

Each release candidate produces one versioned acceptance report. It records these identities:

- Product repository and complete commit ID.
- Dashboard base tag and commit ID.
- Database and projection schema versions.
- Adapter, prompt policy, model, and scanner versions.
- Fixture set digest.
- Test commands and results.
- Backup snapshot ID and restore result.
- Deployment target and build time.
- Owner approval time.

The report stores links to detailed logs. It does not store health values or source text.

Any failed blocking gate stops the release. A waiver cannot bypass data loss, unsafe writes, access control, or restore failures.

## Fixture coverage

The accepted fixture set contains safe synthetic data. Production acceptance never uses the Owner's real health data.

The set covers these input types:

- Text PDF and scanned PDF.
- DOCX and XLSX.
- Plain UTF-8 text, CSV, JSON, and XML.
- JPEG, PNG, and WebP.
- Provider ZIP and generic archive failures.
- One DICOM file and one DICOM study archive.

It includes English and Lithuanian text, duplicate bytes, changed exports, corrections, conflicts, and incomplete dates.

It includes unknown units, unsupported records, poor OCR, large archives, interrupted runs, and adapter version changes.

Security fixtures cover malware, false extensions, macros, encrypted archives, path traversal, links, devices, expansion limits, and prompt injection.

The Health Summary fixture covers all 15 Health Sections. Empty and partial states remain visible.

## Extraction gates

Every expected Source Fact must match its typed fixture value and source meaning.

Every published Record Revision must link to its expected Source Fact and Evidence.

Every Evidence locator must reopen the exact page, region, row, cell, entry, tag, frame, or text span.

Repeated processing with identical versions must produce the same ledger identities. It must not create another accepted revision.

Duplicate bytes must reuse stored content and create a separate Import Event.

Low-confidence and conflicting candidates must enter review. They must not publish automatically.

AI automatic publication requires the accepted adapter evaluation and runtime thresholds from ADR 0002.

No high-risk clinical candidate can publish outside its accepted policy.

Deletion tests must remove live sensitive data and preserve only the allowed deletion receipt.

All extraction assertions must pass. There is no error budget for fixture truth, identity, Evidence, or policy routing.

## Rebuild gates

Delete every Query Projection in the acceptance environment. Rebuild it only from the ledger and source-object manifest.

The rebuilt projection digest must match a clean build's digest for the same versions.

Every visible record must resolve to its current accepted Record Revision and Evidence.

Former revisions, rejected candidates, and source conflicts must remain available through their dedicated history or review views.

Projection failure must leave the ledger unchanged. Retry must complete without another Record Revision.

A complete Owner export must restore into an empty acceptance instance. Its rebuilt digest must match the source instance.

## Visual and responsive gates

Acceptance checks light and dark themes at these viewport sizes:

- `390x844`
- `768x1024`
- `1440x900`
- `1920x1080`

All 15 sections must support loading, ready, partial, empty, and error states.

The page must have no horizontal overflow. Charts, tables, evidence views, Uploads, and Chat must retain mobile feature parity.

Keyboard use, visible focus, landmarks, labels, dialogs, and focus return need manual checks.

Text must work at 200 percent zoom. Motion must respect reduced-motion settings.

Automated accessibility checks must find no critical or serious issue. Manual checks must meet WCAG AA behavior.

Approved screenshots compare the implementation with the visual contract. They do not require a pixel copy of Helix.

## Chat gates

An Ask action must attach Context References and send no message.

Conversation replay must retain exact revision references. Every Owner-specific claim must resolve to its citation.

Evidence links must reopen the exact source location. Prompt injection fixtures must not alter policy or tool access.

Chat can create an exact Change Proposal. It cannot change a record before Confirmation.

A typed message such as "yes" must not confirm a proposal.

Confirmation must reject expired, stale, altered, or unauthorized proposals.

A valid confirmation must add one Owner-authored revision and preserve all former revisions.

Undo must add another revision. Source Facts and model output must remain unchanged.

Medical boundary tests cover diagnosis, prescriptions, dose changes, false safety claims, uncertainty, and urgent warning signs.

## Storage gates

Health gets an initial live storage budget of 100 GiB.

The budget includes source objects, quarantine data, derived artifacts, PostgreSQL data, and platform state.

Health warns at 80 GiB. It stops new uploads at 95 GiB but keeps reads, review, export, and deletion available.

A release needs at least 150 GiB and 25 percent free on `/srv`.

One upload can still use the 2 GiB stored and 20 GiB expanded limits from ADR 0002.

Temporary extraction data counts against the budget. Cleanup tests must recover it after success, failure, cancellation, and deletion.

## Backup and restore gates

Backups run every six hours. They use encrypted off-host storage.

Health uses a dedicated backup repository or deletion-isolated snapshot set.

The shared dashboard job excludes Health's sensitive paths only after the dedicated backup passes a restore drill.

Each backup contains these items:

- Source objects and their digest manifest.
- A consistent PostgreSQL ledger dump.
- Workspace and platform state snapshots.
- Instance configuration without decrypted secrets.
- The deployed product and base commit IDs.

Query Projections and application source can be rebuilt. A backup may omit them.

Retention keeps eight recent snapshots, seven daily, four weekly, and twelve monthly snapshots.

The recovery point target is six hours. The recovery time target is four hours.

Before cutover, restore the newest successful snapshot into an isolated empty instance.

The restore must pass digest checks, ledger checks, projection rebuild, evidence opening, login, upload, and Chat read tests.

Run the same restore drill every quarter. A failed drill blocks the next production release.

## Deployment gates

Build from a clean `Yiin/dashboard-health` commit that exists on `origin`.

The deployed source must report its product commit, base commit, schema versions, and build time.

Run migrations against a disposable database copy before production.

The Health service uses its own source tree, process, state, PostgreSQL database, object namespace, and tailnet hostname.

Pairing, DPoP, scoped File Browser access, secret loading, and tailnet-only access must pass.

Service restart, host restart, log rotation, backup, restore, deploy, and rollback must pass.

Load checks include a 2 GiB streamed upload, a 20 GiB expanded archive, long extraction, and simultaneous Chat reads.

The acceptance environment must purge its synthetic data after the report is complete.

## Cutover

Health starts fresh. Do not import the current site's database or uploaded files.

Use this cutover order:

1. Deploy the new service at `health-next.yiin.lt`.
2. Complete acceptance, backup, restore, and Owner approval.
3. Put the current site in read-only mode.
4. Take and verify its final independent backup.
5. Record the current Caddy route and Coolify service identity.
6. Replace the `health.yiin.lt` route from port `3100` to the new service.
7. Validate Caddy before reload.
8. Test login, Summary, Uploads, evidence, Chat reads, proposals, Confirmation, and export.
9. Keep the former site read-only for 14 days at `health-old.yiin.lt`.
10. Stop its application after the observation period and Owner approval.

The former site's final backup uses an isolated 90-day retention set.

Deletion after that date still needs explicit Owner confirmation.

The new service remains the only writable Health site after the hostname switch.

## Rollback

Rollback restores the former Caddy route to port `3100`. It restarts the former service if required.

Rollback starts for these events:

- Any unauthorized access or unsafe Chat write.
- Confirmed ledger corruption, source loss, or wrong Evidence.
- An outage longer than 15 minutes during cutover.
- A failed new backup or restore after cutover.
- A critical security or data-deletion fault.

Before rollback, stop writes to the new service and take a protected backup.

Do not merge new records into the former site during emergency rollback. Keep the new backup for later recovery.

Validate Caddy, login, read-only behavior, and the final old-site backup after rollback.

Minor visual defects can use a normal fix. They do not require rollback unless they hide unsafe or incorrect health data.

## Release decision

The Owner approves one complete acceptance report. Approval names the exact product commit and backup snapshot.

Release stays blocked when any critical gate fails or any result lacks evidence.

After 14 stable days, the Owner can approve former-service shutdown.

After 90 days, the Owner can separately approve former-data deletion.

## Consequences

The current backup job needs PostgreSQL and object-storage support for Health.

The current Caddy block on port `3100` becomes the tested rollback route.

Health needs quota reporting, upload blocking, release reports, restore automation, and synthetic fixtures.

The cutover creates no data migration risk. It still protects the former site and its final backup.
