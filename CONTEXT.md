# Health

This context defines the personal health record and its summary.

## Language

**Health Summary**:
The main surface that presents the complete health record as one page of health-domain sections.
_Avoid_: Dashboard

**Owner**:
The only person whose health data Health stores and displays.
_Avoid_: User, patient, account

**Health Section**:
A named part of the Health Summary that groups records from one health domain.
_Avoid_: Provider section, source section

**Health Summary Sections**:
The canonical sections are Overview, Profile and Vitals, Longitudinal Record, Lab Results, Daily Health, Sleep, Glucose, Fitness, Clinical Record, Body Composition, Medical Imaging, Supplements, Health Timeline, Cheatsheets, and Travel.
_Avoid_: Helix sections

**Data Source**:
The provider, file, device, or system from which a health record came.
_Avoid_: Health section

**Source Document**:
An immutable file or structured payload copied into Health from a Data Source.
_Avoid_: Health Record, projection

**Import Event**:
One attempt to add a Source Document to Health through a named adapter.
_Avoid_: Source Document, sync state

**Source Fact**:
Data stated directly by a Source Document, kept with its original meaning and location.
_Avoid_: Health Record, derived fact

**Derived Fact**:
Data produced by a parser, model, rule, conversion, or Owner action.
_Avoid_: Source fact

**Health Record**:
One logical health fact about the Owner across all accepted corrections and source links.
_Avoid_: Source fact, record revision, projection

**Record Revision**:
One immutable version of a Health Record.
_Avoid_: Health Record, edit

**Evidence**:
A link from a Source Fact or Record Revision to a precise location in a Source Document.
_Avoid_: Citation text, provenance

**Provenance**:
The recorded origin and derivation chain for a Source Fact, Record Revision, or Derived Fact.
_Avoid_: Evidence, source label

**Query Projection**:
A rebuildable view of accepted Health Records for one query or product surface.
_Avoid_: Source of truth, Health Record

**Pending Record Candidate**:
A possible health record that the importer cannot publish safely because its meaning, identity, required data, or evidence remains uncertain.
_Avoid_: Unconfirmed record, draft fact

**Reference Range**:
The interval supplied for one measurement by its source, including its unit and applicable context.
_Avoid_: Goal, target

**Personal Goal**:
A target that the Owner chooses for one health metric and time period.
_Avoid_: Reference range, normal range

**Range Status**:
Health's factual comparison of one measurement with its own reference range: below range, in range, above range, or no range.
_Avoid_: Good, bad, healthy, unhealthy

**Source Interpretation**:
The assessment supplied by a data source for one measurement, such as high, critical, or abnormal.
_Avoid_: Range status, Health interpretation

**Goal Status**:
Health's comparison of current progress with a Personal Goal: on target or off target.
_Avoid_: Range status, source interpretation

**Point Measurement**:
A measured value that applies at one recorded time.
_Avoid_: Current state, carried value

**Stateful Fact**:
A fact that applies through a recorded effective period, such as an active medication.
_Avoid_: Point measurement

**Explicit Estimate**:
A derived value that Health labels as inferred and links to its method, inputs, and evidence.
_Avoid_: Measurement, carried value

**Typed Continuity**:
The chart rule that stops Point Measurements at their dates and continues Stateful Facts through their effective periods.
Explicit Estimates remain visibly different.
_Avoid_: Carry every latest value forward

**Data Freshness**:
The age of the latest known value, shown with its measurement date.
Health labels a value stale only when it knows the expected source or goal cadence.
_Avoid_: One global stale threshold
