---
status: accepted
---

# Use a versioned upload-to-record pipeline

Health scans each source before processing it. It writes source data and evidence before it publishes records. Deterministic adapters run before AI, and uncertain candidates go to review.

## Accepted inputs

Version one accepts these file groups:

- Documents: PDF, DOCX, XLSX, plain UTF-8 text, CSV, JSON, and XML.
- Images: JPEG, PNG, and WebP.
- Archives: ZIP files from supported providers.
- Medical images: DICOM files and ZIP files that contain DICOM studies.

Health rejects executable files, macro-enabled Office files, encrypted archives, and other archive formats. It never executes active content from an upload.

Each uploaded file can contain up to 2 GiB of stored bytes. Large provider exports must use parts that fit this limit.

A ZIP file can contain up to 200,000 entries and 20 GiB of expanded data. One entry cannot expand beyond a ratio of 100 to 1. Health rejects path traversal, link entries, device entries, and archive nesting beyond one level.

The filename allowlist is an early check. The scan result decides the actual media type. A false extension does not make unsafe content valid.

## Pipeline

One Import Event records every submission, including a byte duplicate. One Processing Run records the versioned work for a Source Document.

A run uses these stages:

1. Receive streams the bytes to quarantine storage. It records the size, SHA-256 digest, filename, and upload time.
2. Scan checks malware signatures, the real file type, container structure, and archive limits.
3. Classify selects a provider-neutral document type and adapter.
4. Extract reads source statements and creates typed Evidence locators.
5. Normalize parses values, units, codes, times, and identifiers without changing source values.
6. Decide creates Record Candidates and applies publication rules.
7. Publish writes Source Facts, Evidence, Provenance, Health Records, and accepted Record Revisions.
8. Project updates query tables and indexes from accepted revisions.
9. Enrich creates optional summaries and insights after the authoritative write.

The Publish stage commits the ledger before any Query Projection changes. Projection or enrichment failure cannot undo an accepted revision.

Enrichment does not block a successful import. The UI can show a completed import with an enrichment warning.

## Quarantine and scanning

New bytes stay in a quarantine object namespace. Parsers, previews, downloads, and AI services cannot read them until the scan passes.

Health uses a local malware scanner. It does not send health files to a separate scanning service.

The scan stores its engine version, signature version, result, and time. Health fails closed when the scanner is unavailable. The Owner can retry the scan but cannot bypass a malware result.

Archive readers stream entries and check paths before extraction. XML readers disable external entities and network access. Office readers do not run macros. Preview tools run without network access and with CPU, memory, and time limits.

Health keeps original bytes unchanged. A safe preview or OCR image is a Derived Fact with its own digest and Provenance.

## Classification and adapters

Classification uses this order:

1. An explicit Owner type override.
2. Magic bytes and container markers.
3. A deterministic adapter signature.
4. AI classification for ambiguous documents.

An override selects an adapter. It does not bypass scanning, parsing checks, or publication rules.

AI classification can continue automatically at a calibrated score of 0.80 or more. A lower score creates a review item. An `unknown` result parks the document in Owner review (`needs_owner_review`) and publishes no records.

Each adapter records its name, version, schema version, configuration version, and code digest. Provider adapters map into the common record envelope. They keep fields that the common model does not yet understand.

Structured provider exports use deterministic parsers first. Text PDFs use their text layer. Scans and photos use OCR or vision only when deterministic text is unavailable.

## Source facts and evidence

Every published Record Revision links to at least one Source Fact and one Evidence item. An Owner-created record can omit Evidence, but its Provenance must name the Owner.

Evidence uses a typed locator:

- PDF and image: one-based page number, bounding polygon, and text span when available.
- CSV and spreadsheet: sheet, row, column, header, and byte span when available.
- XML and JSON: entry path, stable source identifier, and byte span when available.
- Archive: entry path and child Source Document.
- DICOM: study, series, instance, tag, and frame identifiers.
- Plain text: line and character span.

The locator must reopen the source at the cited place. A filename or document ID alone is not enough evidence.

Query Projection rows keep the Record Revision ID and Evidence IDs. Dashboard and chat views can therefore return to the original source.

OCR text, AI output, code mappings, unit conversions, and summaries are Derived Facts. Health records their inputs, method, model or parser version, and output.

Health stores validated model output for audit. It does not store hidden reasoning. Temporary AI provider files are deleted after each call, and Health records the cleanup result.

## Confidence and automatic publication

Health records confidence per candidate and per required field. It does not use one document-wide average to publish records.

The score comes from a calibrated adapter evaluation. Model self-reported confidence is only one input.

Deterministic output can publish automatically after schema, identity, unit, date, evidence, and conflict checks pass.

AI output can publish automatically only when all these rules pass:

- The adapter has at least 99.5 percent precision for the record type on the accepted evaluation set.
- The candidate score is at least 0.98.
- Every required field score is at least 0.98.
- Every required field has precise Evidence.
- No required value, unit, date, code, or identity depends on a guess.
- The candidate does not conflict with an accepted record.
- The candidate does not replace an Owner correction.

A new or changed AI adapter starts with automatic publication disabled. Evaluation can enable it for one record type at a time.

AI-extracted conditions, allergies, medications, procedures, and imaging findings require Owner review by default. A separate accepted evaluation can enable one type later.

Quantitative lab, vital, and wearable records can publish automatically when the rules pass. AI summaries and interpretations never become Health Records by themselves.

Publication happens per candidate. One uncertain candidate does not hold back safe candidates from the same source.

## Review

A Pending Record Candidate states why it needs review. Reasons include low confidence, missing evidence, an unknown unit, an incomplete date, an identity collision, and a source conflict.

The review screen groups candidates by Source Document. It shows the source excerpt beside the parsed fields.

The Owner can accept, edit and accept, reject, change the document type, or retry extraction. An edit creates an Owner-authored Record Revision. It does not change the Source Fact or model output.

Health keeps rejected candidates and their reasons until the Source Document is deleted. Reprocessing does not reopen an unchanged rejected candidate unless the adapter, policy, or source changes.

Bulk acceptance is available only for one record type and one adapter version. Each candidate must still pass its required-field checks.

## State and visible progress

Import state, Processing Run state, and candidate review state are separate. A document can complete while some candidates wait for review.

The Import Event uses these terminal results:

- `complete`: all valid candidates were published or rejected by policy.
- `complete_with_review`: at least one candidate needs Owner review.
- `needs_owner_review`: the file is safe but Health cannot read or label it yet; its bytes are retained and it can be reprocessed later.
- `rejected`: scanning or structural validation rejected the file.
- `failed`: processing stopped after its retry budget.
- `deleted`: the purge finished.

Amendment (health-3fq.21): `unsupported` was a terminal failure result, which contradicted "no legitimate document is ever rejected or discarded." It is renamed to `needs_owner_review` and dropped from the Processing Run error class set: a held run succeeds with `error_class` null and a `hold_reason` recorded, it never fails.

Each stage records `queued`, `running`, `waiting`, `retrying`, `succeeded`, `failed`, or `cancelled`. It also records start time, finish time, attempt count, error class, and work counters.

The upload progress bar uses bytes sent over total bytes. Processing shows named stages, not a fake percentage.

Archive adapters show entries discovered, processed, skipped, failed, and pending review. Long parsers also show their checkpoint unit, such as XML records or DICOM instances.

The server stores progress events. The client can use server-sent events with snapshot polling as a fallback. Reloading the page does not lose stage times or progress.

The final result shows published, duplicate, rejected, and review counts. It also shows the next available action.

## Retries and recovery

Retries are stage-specific and idempotent. A stage artifact key includes the Source Document, Processing Run, stage name, input digest, implementation version, and configuration version.

Health reuses a completed artifact only when every key part matches. A new adapter, prompt, model, policy, or source digest invalidates the affected stage and every later stage.

Transient code or input-service errors get three stage executions. Provider outages get up to five more executions and do not consume the three error executions. Retries use exponential backoff, jitter, and `Retry-After` when the provider supplies it.

Invalid input, malware, unsupported content, and low confidence do not retry automatically.

A worker lease and heartbeat recover abandoned work. Stream parsers checkpoint after bounded batches. One failed archive entry does not fail entries that already completed.

The Owner Retry action continues the same Processing Run. A type override invalidates classification and every later stage.

Reprocess creates a new Processing Run with current versions. It keeps former runs and their Provenance. It skips a new revision when typed content and Evidence match an existing revision.

Reprocessing cannot replace an Owner revision automatically. A changed candidate waits for review beside the current Owner revision.

## Duplicate handling

SHA-256 identifies stored bytes, not a health fact.

Each submission creates an Import Event. Matching bytes reuse the stored blob and existing Source Document. The event reports `duplicate` and links to the earlier import.

A duplicate does not start another Processing Run when a successful run already exists for the same versions. It can attach new origin metadata without creating new Source Facts.

A changed adapter or policy can start a new run against the same Source Document. That is reprocessing, not another upload.

A Source Fact identity uses the Source Document, source version, locator, and provider identifier when present. Repeated processing cannot create the same Source Fact twice.

Health does not merge records by display name, date, normalized code, or digest alone. A deterministic identity rule or Owner review can join records.

Query Projections can collapse exact duplicate values. They keep all supporting Evidence links.

## Deletion

Deleting a Source Document cancels active work and hides its records from Query Projections at once. A purge job then removes the bytes and all linked sensitive data.

The purge removes these items:

- Quarantine and original objects when no other Source Document uses the blob.
- Preview, OCR, extracted text, stage artifacts, model output, and search indexes.
- Source Facts and Evidence owned by the document.
- Record Candidates and Record Revisions that depend only on the deleted source.
- Query Projection rows that no longer have an accepted revision.
- Temporary provider files that Health can still identify.

If a revision has other Evidence, Health removes only the deleted source link and rebuilds the projection. It keeps the revision when the remaining evidence still satisfies its publication policy.

Archive deletion includes child Source Documents that came only from that archive. A child imported separately remains through its separate source link.

Purge uses a generation guard. A late worker cannot write new data after deletion starts.

Health keeps a non-sensitive deletion receipt. It contains random internal IDs, the deletion time, scope, status, and final backup expiry. It does not contain filenames, digests, extracted text, health values, or Evidence.

The live system reports deletion complete only after object storage, database data, indexes, and known provider files are clear. Existing backups expire under the configured backup retention policy.

## Scenarios

An Owner uploads the same lab PDF twice. Health creates a second Import Event, reuses the Source Document, and shows "Already imported." It does not create another lab result.

A lab report has 30 clear results and one unit that OCR cannot read. Health publishes the 30 safe candidates and sends one candidate to review.

An Owner corrects a medication dose. A later model extracts a different dose from the old source. Health keeps the Owner revision current and sends the new candidate to review.

A Takeout archive has 10,000 entries and three invalid CSV files. Health keeps progress for every entry, publishes valid records, and finishes with three review or failure items.

Two sources support one lab result. Deleting one source removes its Evidence. The record remains if the other Evidence still passes publication rules.

## Consequences

The current pipeline can keep its streamed upload, object storage, PostgreSQL queue, and deterministic parsers.

The current `documents.sha256` uniqueness must move to a stored-blob layer. Import Events must record duplicate submissions.

The current stage cache needs versioned keys and durable progress events. Client-observed stage times are not authoritative.

The upload allowlist must add DOCX, XLSX, and DICOM. The scanner must verify content before the existing classifier runs.

The current 0.60 classification threshold can route files for review, but it cannot authorize record publication.

Current parsers write directly to query tables. They must first write Source Facts, Evidence, Record Candidates, and accepted Record Revisions.

Deletion needs a guarded purge workflow. Removing a `documents` row alone cannot satisfy the deletion contract.
