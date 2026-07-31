---
status: accepted
---

# Keep an immutable health ledger and rebuild query projections

Health keeps source meaning and record history in an immutable ledger. It builds replaceable query projections from that ledger. This split preserves evidence and corrections while keeping dashboard queries small.

## Authoritative data

Health has two kinds of authoritative data.

Source Documents and Source Facts define what each source stated. Health never edits them.

Health Records and their accepted Record Revisions define Health's current record. A correction adds a revision instead of changing an earlier revision.

Query Projections are not authoritative. Health can delete and rebuild them from the ledger.

## Ledger model

The ledger uses these entities:

- A Source Document is an immutable file or structured payload. Health stores its bytes in object storage and its metadata in PostgreSQL.
- An Import Event records one ingestion attempt. It names the adapter, adapter version, Data Source, time, result, and Source Document.
- A Source Fact stores one source statement. It keeps the source name, value, unit, codes, times, status, and unmodeled raw payload.
- Evidence links a Source Fact or Record Revision to a page, region, row, cell, entry path, or text span.
- A Health Record gives one logical fact a stable internal identity.
- A Record Revision stores one immutable version of a Health Record.
- Provenance links every extraction, mapping, conversion, merge, correction, and review to its inputs and agent.

Each record type uses a common envelope. The envelope holds its type, status, effective time, recorded time, external identifiers, source links, and schema version. A typed payload holds details for a lab result, medication statement, condition, workout, or other health concept.

The common envelope stays provider neutral. Provider adapters map source data into it. They also keep the full Source Fact when no normalized field exists.

A Health Record has at most one current accepted Record Revision. The record points to that revision. Moving this pointer does not change or remove earlier revisions.

## Identity and duplicate handling

Health gives each Source Document, Source Fact, Health Record, and Record Revision its own stable internal ID.

Health stores each external identifier as a system and value pair. It also keeps type, use, period, and assigner when present. A bare value never identifies a record.

A content digest identifies bytes, not a health fact. Health records the digest algorithm and value. Matching bytes can share stored content while separate Import Events remain visible.

A Source Fact uses its Source Document version and source locator as its source identity. A provider record ID can strengthen that identity. Repeating the same import must not create another Source Fact or Record Revision.

Health does not merge records by display name, date, or normalized code alone. A deterministic adapter rule or an Owner review can join identities. The merge keeps every former identity and source link.

A replacement or transformed Source Document gets a new identity. A typed relationship links it to the former Source Document.

## Values, codes, and units

A Source Fact keeps the exact text, value type, comparator, unit string, and source code.

A Record Revision can add parsed quantities and normalized codes. A code keeps its system, version, code, display, and original text.

Health uses case-sensitive UCUM codes when it has a reliable unit mapping. A converted value is a Derived Fact with its method, inputs, and output unit. It never replaces the source value.

## Corrections, conflicts, and history

A correction creates a Record Revision with its actor, time, reason, and parent revision. The former revision stays available as history.

A revision can supersede another revision or mark it as entered in error. Point Measurements keep their measurement time. Stateful Facts keep their effective period. Every revision also keeps the time Health recorded it.

Conflicting sources remain separate. Health links the revisions as a conflict and shows the conflict in review surfaces. A resolution adds an accepted revision with provenance and keeps both source claims.

An exact duplicate can collapse in a Query Projection. Its Evidence still lists every matching source.

Reprocessing can create a candidate revision. It cannot replace an Owner correction without review. Health skips a new revision when its typed content and evidence match an existing revision.

Owner-requested deletion is the exception to immutable history. Health purges the selected sensitive bytes and linked ledger content. It can keep a non-sensitive deletion receipt.

## Query projections

Each Query Projection has a schema version and build version. Its rows include the ledger IDs needed for evidence and chat citations.

Health can use PostgreSQL tables, materialized views, or search indexes for projections. The choice can differ by query. Labs, daily metrics, workouts, timeline events, current medications, dashboard cards, and chat retrieval can each use a small typed shape.

Projection builders read accepted revisions and their evidence. They can checkpoint work, resume after failure, and rebuild one projection without changing the ledger.

The current `biomarker_results`, `daily_metrics`, and `workouts` shapes are projection candidates. Their overwrite and duplicate rules must not define record history.

## Large exports and portability

Health streams large uploads to object storage. It calculates the digest during the stream and does not place file bytes in PostgreSQL.

Archive adapters read entries as a stream and checkpoint their position. They do not unpack a whole export into memory or make one database transaction cover the full export.

Import is copy-in. Health does not move or rewrite the Owner's source file.

Backups copy the source archive and ledger separately from query projections. A complete Owner export contains Source Documents, a digest manifest, Source Facts, accepted revisions, history, and provenance. It does not require projection files.

This export makes the record portable to another Health instance. New provider adapters use the same ledger and projection boundaries.

## Rejected options

Health will not use uploaded files alone as the query model. Queries would need repeated parsing and could not represent corrections cleanly.

Health will not treat current dashboard tables as the source of truth. Their overwrite rules lose source conflicts and revision history.

Health will not store only FHIR resources. Health keeps useful FHIR semantics without requiring a FHIR server or making one exchange format its internal model.

Health will not use a full event stream as the only state. Record revisions and provenance give the required history with simpler queries and migrations.

## Consequences

The ledger costs more storage and adds joins. It also makes reprocessing, adapter changes, corrections, citations, and provider additions safe.

The upload pipeline must write ledger data before projections. Chat and dashboard code must read projections but return ledger evidence IDs.

Schema work can add these entities in stages. Existing source files and extracted payloads can seed the ledger before current query tables become rebuildable.
