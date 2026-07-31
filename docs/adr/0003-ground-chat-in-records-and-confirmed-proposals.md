---
status: accepted
---

# Ground Chat in records and confirmed proposals

Chat reads accepted Health data through limited tools. It can create a Change Proposal, but only the Owner can confirm it.

## Turn context

An Ask Chat action attaches one or more Context References. It opens Chat and never sends a message.

A Context Reference points to a Health Record, Record Revision, Evidence item, or Health Section. It never contains copied record prose.

The chip shows the record type, label, date, and Data Source. The Owner can remove any chip before sending.

Each Owner message stores its Context References and exact revision IDs. Conversation replay uses those stored versions, not silently updated records.

The model receives only these items:

- The current Owner message and a bounded conversation history.
- The selected Context References.
- Small tool results needed for the question.
- The Owner's language, locale, time zone, and current date.
- The Health policy and tool descriptions.

Health does not place the full Health Summary or source archive in every prompt.

## Read tools

Chat gets these read-only tools:

- `get_health_summary` reads a bounded section or card projection.
- `search_health_records` searches accepted records by text, type, and date.
- `get_health_record` reads one accepted record and its current revision.
- `get_record_history` reads the immutable revisions for one record.
- `get_metric_series` reads bounded measurements for one metric and period.
- `compare_health_records` compares selected record revisions.
- `get_source_evidence` reads one exact Evidence location and a bounded excerpt.

Every tool uses typed inputs and bounded results. List tools use cursors and enforce server limits.

Read tools return accepted Record Revisions by default. They return candidates only in an explicit review context.

The model cannot use SQL, the file system, the network, a shell, object storage, or internal service APIs.

The server authorizes every call. It limits result size, date range, execution time, and call count.

Health treats source text as untrusted data. Instructions inside a Source Document cannot change Chat policy or tool access.

## Citations

Every Owner-specific factual claim must cite its supporting record data.

A citation contains these fields:

- Record Revision ID.
- Evidence ID, when Evidence exists.
- Source Document title.
- Typed locator.
- Quoted text or source value.
- Data Source and effective date.

The interface links each citation to the exact page, region, cell, frame, entry, or text span.

An Owner-created record cites its Owner Provenance when no Evidence exists. Health labels that source as Owner entered.

A Derived Fact cites its inputs and method. Its citation never presents the derived output as a source statement.

Chat states when evidence is absent, incomplete, old, or conflicting. It does not make an unsupported Owner-specific claim.

The current filename and quote citation shape is insufficient. It must add Record Revision IDs, Evidence IDs, and typed locators.

## Change proposals

Chat has no direct record mutation tool.

`propose_record_change` can propose these operations:

- Create an Owner-authored Health Record.
- Correct fields on the current Record Revision.
- Mark a record entered in error.
- Resolve a recorded source conflict.

The tool requires the operation, typed fields, reason, Context References, and expected current revision.

The server validates the proposal against the record schema and current policy. It stores an immutable Change Proposal and returns an exact diff.

The proposal shows every changed field, its former value, its proposed value, its sources, and its reason.

The proposal expires after 15 minutes. It also expires when its expected revision or policy changes.

Chat cannot propose Source Document deletion, source purge, credential changes, or retention changes. Those actions use their dedicated interfaces.

## Confirmation and correction

Confirmation is a separate Owner interface action on one exact Change Proposal. Natural-language agreement cannot confirm a proposal.

The confirmation endpoint checks the proposal, actor, expiry, expected revision, and current policy again.

A stale proposal fails with a conflict. Chat must create a new proposal from the current revision.

A successful confirmation writes one Owner-authored Record Revision and its Provenance in one transaction. It then rebuilds affected projections.

Health never changes a Source Fact, model output, Evidence item, or former Record Revision.

Undo creates another Change Proposal and Record Revision. It never removes history.

Medication, allergy, condition, procedure, and imaging changes show a high-impact label. They use the same exact confirmation rule.

## Audit data

Health stores these items for each Chat turn:

- Message content and Context References.
- Prompt policy version, model, and provider.
- Tool names, validated arguments, result digests, and timing.
- Record Revision IDs and Evidence IDs returned to the model.
- Final citations and answer.
- Change Proposal, Confirmation, and resulting revision IDs.

Health stores validated model output. It does not store hidden reasoning.

Health keeps conversations until the Owner deletes them. Archive hides a conversation but does not delete it.

Conversation deletion removes its messages, tool results, cached prompt data, and known temporary provider files.

Conversation deletion does not remove Health Records. Record deletion remains a separate confirmed action.

## Sensitive data

Chat sends the model only fields and excerpts required for the current question.

Health never sends credentials, tokens, system configuration, unrelated records, or an unbounded source archive.

Temporary provider files expire after each request. Health records the cleanup result.

Logs use internal IDs and result digests. They do not contain source text, health values, prompts, or model responses.

Tailnet access does not remove these controls. Pairing, DPoP, and server authorization still apply.

## Medical boundary

Chat can describe values, dates, trends, source ranges, source interpretations, and data gaps.

Chat can explain common medical terms from a cited source. It can help the Owner prepare questions for a clinician.

Chat cannot diagnose, exclude a diagnosis, prescribe treatment, change a dose, or advise stopping medication.

Chat cannot claim that an in-range value proves safety. It must state relevant uncertainty and Data Freshness.

Chat separates a source's interpretation from Health's Range Status. It does not label Health data as good, bad, healthy, or unhealthy.

When the Owner reports urgent warning signs, Chat tells them to seek urgent local care now.

Health obtains emergency contact details from maintained locale configuration. The model never invents a telephone number.

Chat does not delay urgent guidance to search records. It still avoids a diagnosis.

## Failure behavior

Chat fails closed when authorization, validation, or citation assembly fails.

A tool timeout returns a clear partial-result message. The model cannot replace missing data with a guess.

A failed projection rebuild does not undo an accepted revision. Health marks the affected view stale and retries the rebuild.

Provider failure cannot lose an Owner message or confirm a Change Proposal.

## Required scenarios

Acceptance tests cover these cases:

- An Ask action attaches one record and sends nothing.
- Conversation history reopens the exact attached revision.
- A trend answer cites every source value it uses.
- A manual record cites Owner Provenance.
- A malicious source instruction cannot change tool policy.
- A message saying "yes" cannot confirm a proposal.
- A stale proposal cannot overwrite a newer revision.
- Confirmation writes one revision and preserves the former revision.
- Undo creates another revision.
- A record purge request moves to the dedicated deletion interface.
- A question with missing evidence states the gap.
- A normal value does not produce a safety claim.
- An urgent message gets immediate care guidance without a diagnosis.

## Consequences

The existing conversation tables need Context References and audit metadata. Tool results should use digests outside bounded replay data.

The existing tools need ledger-backed replacements. The current query tables can remain behind projection adapters during the transition.

The interface needs proposal cards, exact diffs, expiry, conflicts, Confirmation, and evidence links.

Chat becomes useful for corrections without giving the model authority to change the health ledger.
