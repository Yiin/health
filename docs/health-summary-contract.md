# Health Summary Contract

Status: Approved

The Owner approved every recommended shared rule and every proposed section contract.

The visual review record is in `.lavish/health-summary-contract-review.html`.
Domain terms are in `CONTEXT.md`.

## Scope

Health Summary is the default Health surface.
It shows one Owner's private health record on one long page.

This contract does not define storage, upload thresholds, Chat tool safety, responsive layout, or release rules.
Other Wayfinder tickets cover those topics.

## Canonical sections

Use these section names and this order:

1. Overview
2. Profile and Vitals
3. Longitudinal Record
4. Lab Results
5. Daily Health
6. Sleep
7. Glucose
8. Fitness
9. Clinical Record
10. Body Composition
11. Medical Imaging
12. Supplements
13. Health Timeline
14. Cheatsheets
15. Travel

Section names describe health domains.
Provider names identify Data Sources.

## Shared states and records

Every section keeps its heading and navigation entry visible.

Every section supports loading, ready, partial, empty, and error states.

Health Summary excludes Pending Record Candidates.
It shows their count and links to Uploads.

A row offers Open details, View source, and Ask Chat.

View source opens the exact evidence location inside Health.
Original download remains a secondary action.

Ask Chat attaches removable Context References.
It opens Chat and never sends automatically.

Summary cards attach one Context Reference.
Record lists support multiple Context References.

## Range and goal meaning

Each measurement uses its own dated source range.

Range Status is below range, in range, above range, or no range.

Source Interpretation preserves an imported flag, such as high or critical.

Personal Goals stay separate from source ranges.
Goal Status is on target or off target.

Health does not label measurements good or bad.

The Owner edits goals near their metrics.
Health keeps effective dates and change history.

## Chart contract

Use Typed Continuity.

A Point Measurement stops at its recorded date.
A Stateful Fact continues through its recorded effective period.

An Explicit Estimate uses a dashed or otherwise distinct style.
It includes its method, inputs, evidence, and inferred label.

A chart never converts missing data to zero.
A null value breaks the line.

A card can show the latest known value after its date.
It must also show the date and age.

Health labels a value stale only with a known source or goal cadence.
Do not use one global threshold.

Use metric-specific views.
Labs show original points.
Dense sources can show labelled aggregates.

Do not smooth source data.
Display interpolation must not create stored or reported measurements.

Use metric-specific default windows.
Glucose opens one day.
Daily metrics open 30 days.
Sleep opens 90 nights.

Sparse clinical records open all available history.
Remember the Owner's last window choice for each section.

Show dated source ranges as neutral bands.
Show Personal Goals as separate labelled lines or bands.

Use preferred display units when conversion is reliable.
Details preserve the source value, unit, and conversion.

Use event-local time when known.
Details preserve UTC and the source time zone.

Refresh affected sections after saved changes.
Keep a manual refresh action and show the last update time.

## Helix chart findings

The public Helix site at `https://health.martinamps.com` uses Recharts.

The inspected bundle was `/assets/index-CT4b6l-X.js` on 2026-07-31.
It exposes no package version or usable source map.

Helix uses these Recharts parts:

- `ResponsiveContainer`
- `LineChart`
- `AreaChart`
- `BarChart`
- `ScatterChart`
- `ComposedChart`
- `ReferenceArea`
- `ReferenceLine`

Helix chart domains end at their newest point.
Helix does not extend the newest measurement to today.

Helix uses `connectNulls={false}` in its current general trend renderer.
Missing samples break the line.

Helix uses linear segments for laboratory trends.
It uses monotone curves for some dense general trends.

Helix labels weekly means.
Its general renderer aggregates series with over 120 points across more than 90 days.

Health adopts the visual grammar, not that global aggregation threshold.
Each metric must define and label its own transformation.

Helix uses neutral grids, compact axes, custom tooltips, range bands, dashed goal lines, and status dots.

Health should use Recharts.
The current repository already has `recharts@^3.9.2`.

The current repository's old lab chart joins null gaps.
It also uses one newest reference band for all points.

Those behaviors do not meet this contract.
The fresh Health build must use dated ranges and visible gaps.

## Navigation and search

Each section has a stable URL hash.
Direct navigation moves focus to the section heading and adds browser history.

Scroll tracking updates active navigation without adding history.

Command-K searches sections, published records, and source documents.
Results open the exact section, record, or evidence.

Pending Record Candidates remain searchable only in Uploads.

## Section contracts

### Overview

Show current values, recent changes, goals, and attention items.
Include owner-pinned metrics.

Small trends use metric-specific windows.
Cards show source freshness, missing coverage, ranges, and goals.

Groups stay visible when empty.
Offer Upload files without suggesting provider sync.

### Profile and Vitals

Show identity facts, body measurements, vitals, and due health actions.

Use sparse point charts for height, weight, blood pressure, and SpO2.
Show percentiles only with source cohort details.

Separate empty states for profile, vitals, and next actions.

### Longitudinal Record

Show laboratory history in organ-system lanes.
Add dated clinical landmarks.

Use a horizontally scrollable full-history timeline.
Selected comparable markers open a small trend.

Each draw or landmark opens details, sources, and Ask Chat.

### Lab Results

Group markers by organ system and panel.
Show value, unit, range, source flag, date, direction, and sample context.

Expanded rows show original points, dated ranges, goals, gaps, and a data table.

Show zero markers and zero draws when empty.
Explain any excluded Pending Record Candidates.

### Daily Health

Show source-neutral daily activity, fitness, recovery, and body metrics.

Steps use a 30-day target grid.
Other metrics use weekly trends with expandable full history.

Separate no section data from missing dates.
Show source provenance and import freshness.

### Sleep

Show the latest night, stages, recovery measures, and source coverage.

Open 90 nights.
Distinguish sources, travel cities, missing nights, and the optional eight-hour goal.

Separate no sleep records, no night record, and a missing source interval.

### Glucose

Show daily readings, meals, rises, target context, and coverage.

Open the latest covered day.
Previous and next controls skip dates without coverage.

Separate no glucose data, no readings on one date, and a partial day.

### Fitness

Show training volume, activity mix, streaks, records, and recent activities.

Compare distance, duration, and elevation with the prior matching period.

Separate no activities from no filter matches.

### Clinical Record

Keep conditions, medications, allergies, procedures, encounters, immunizations, and family history separate.

Use event timelines and medication effective periods.
Link related imaging and comparable lab trends.

A missing record never proves that a condition is absent.

### Body Composition

Show scan measures, comparisons, goals, and source files.

Compare only compatible scan methods.
Chart compatible measures across all scans.

Explain accepted source files when no scans exist.

### Medical Imaging

Show imaging studies, reports, files, findings, and linked clinical records.

No summary chart is required.
The viewer handles images, PDFs, DICOM series, cine playback, and comparisons.

A study with missing files uses a local error and retry state.

### Supplements

Separate active and stopped products.
Show ingredients, doses, labels, and nutrient totals.

Use effective-period timelines only when history exists.
Never imply clinical adequacy from nutrient totals.

Keep active, stopped, and nutrient groups visible when empty.

### Health Timeline

Show a readable event feed across the health record.

Filter the vertical timeline by year and category.
Do not duplicate the Longitudinal Record chart.

Separate no events from no filtered matches.

### Cheatsheets

Show printable owner-only summaries for appointments, travel, and daily use.

Sheets use current published records unless the Owner freezes a version.

Version one has no public share or unshare actions.

### Travel

Show flights, totals, upcoming trips, and recent travel context.

Use yearly totals and route summaries when enough data exists.
Sleep can use linked travel-city overlays.

Separate no flights from no upcoming flights.

## Resolution

This contract is ready for visual adaptation and responsive work in `health-eho.19`.
