# Health Visual Contract

Status: Approved

Health must match Helix's product capability and information depth.
T3 Code supplies the visual system and interaction quality.

Version one omits direct provider sync.
The design must accept new Data Sources without a layout change.

## Design sources

Use T3 Code for:

- DM Sans typography
- Zinc light and dark surfaces
- Indigo primary controls
- Compact Base UI controls
- Sidebar, sheet, dialog, command palette, tooltip, and focus behavior
- Ten-pixel base corner radius
- Safe-area support
- Fine grain on app chrome

Use Helix for:

- One long health summary
- Persistent section navigation
- Dense health cards and rows
- Expandable record details
- Compact trend charts
- Goal and range overlays
- Source-aware tooltips
- Mobile health shortcuts
- Ask actions beside health records

Do not copy Helix's public sharing model, provider-specific storage, or visual branding.

## Product shell

Health has three main surfaces:

1. Health Summary
2. Uploads
3. Chat

Health Summary opens by default.

The shell keeps navigation stable while the main surface changes.
Uploads and Chat keep their own scroll positions.

The shell uses the T3 Code app background, sidebar surface, border system, and safe-area rules.

## Desktop layout

Desktop starts at 768 pixels.

The left sidebar uses T3 Code's 256-pixel expanded width.
It can collapse to a 48-pixel icon rail.

The sidebar remembers its last state.
The expanded state opens by default at 1200 pixels and wider.

Widths from 768 to 1199 pixels open with the icon rail.
The Owner can expand it without covering the content.

The sidebar contains:

- Health Summary
- Uploads
- Chat
- Summary search
- All 15 Health Sections
- Theme control
- Data freshness and pending review counts

The main canvas fills the remaining width.
It never uses a narrow article column for dense health sections.

Use these content limits:

- 1600 pixels for the full Summary canvas
- 1280 pixels for standard section content
- Full available width for timelines, imaging, and wide comparison charts

Use 32-pixel outer gutters above 1200 pixels.
Use 24-pixel gutters from 768 to 1199 pixels.

Details open in a right sheet between 420 and 520 pixels wide.
The sheet can link to a full record route.

Chat can open beside Summary on wide screens.
It becomes a full main surface when space is limited.

## Mobile layout

Mobile ends at 767 pixels.

Use a fixed top bar and a fixed bottom navigation bar.
Respect all safe-area insets.

The bottom navigation contains:

1. Summary
2. Labs
3. Uploads
4. Chat
5. More

Labs opens the Lab Results section.
More opens the complete section list.

The top bar shows the current section and a search action.
It also opens the off-canvas section sheet.

Use 12-pixel page gutters below 390 pixels.
Use 16-pixel gutters from 390 to 767 pixels.

Cards stack in one column.
Dense rows may become labelled value blocks.

Wide charts scroll inside their own containers.
The page itself never scrolls horizontally.

Record details use a full-height sheet.
The sheet preserves the return position.

Chat opens full screen.
Attached context remains visible above the composer.

## Summary grid

Use a 12-column desktop grid.
Use a 6-column tablet grid.
Use one column on mobile.

Cards can span:

- Three columns for compact metrics
- Four or six columns for standard trends
- Six or twelve columns for detailed groups
- Twelve columns for timelines and viewers

Keep related metrics in one visual group.
Do not place every value in a separate card.

Section spacing is larger than card spacing.
The section heading must remain easy to find during a long scroll.

Use 48 pixels between desktop sections.
Use 32 pixels between mobile sections.

## Typography

Use DM Sans for interface text, headings, labels, values, and chart text.

Use tabular numbers for health values, dates, durations, counts, and axes.
Do not use monospaced type for normal health values.

Use the T3 Code monospaced stack for:

- Source identifiers
- Clinical codes
- File hashes
- DICOM identifiers
- Raw record keys

Recommended sizes:

- Page title: 28 pixels desktop, 24 pixels mobile
- Section title: 20 pixels desktop, 18 pixels mobile
- Card title: 14 pixels
- Body text: 14 pixels
- Metadata: 12 pixels
- Chart axes and compact labels: 10 or 11 pixels
- Primary metric value: 24 to 32 pixels

Use sentence case.
Avoid uppercase text except short metadata labels.

## Surfaces and depth

Use T3 Code theme tokens.
Do not create a second health-specific theme.

Light mode uses:

- Zinc 25 app background
- White cards
- Zinc 200 borders
- Zinc 800 main text
- Zinc 500 secondary text

Dark mode uses:

- Zinc 950 app background
- Zinc 900 cards and popovers
- Low-opacity white borders
- Zinc 100 main text
- Zinc 400 secondary text

Use the T3 Code indigo primary color for selected controls and main actions.

Use ten-pixel card corners.
Use larger radii only for dialogs, command search, and full sheets.

Use one-pixel borders before shadows.
Use soft shadows only for floating sheets, menus, and dialogs.

Use grain on app chrome and the sidebar.
Keep data cards clean for legibility.

## Semantic color

Color supports meaning but never carries meaning alone.

Use these roles:

- Neutral zinc for in-range and no-range values
- Amber for below-range, above-range, and attention states
- Red for imported critical states and destructive actions
- Indigo for selected records and Personal Goals
- Emerald for completed actions and achieved goals
- Blue for information and source links

Always pair color with text, shape, dash, or an icon.

Do not call a health measurement good or bad.
Do not use green as proof of health.

## Chart foundation

Use Recharts.
Start with `recharts@^3.9.2`.
Upgrade it only after the chart acceptance tests pass.

Use these primitives:

- `ResponsiveContainer`
- `ComposedChart`
- `Line`
- `Area`
- `Bar`
- `Scatter`
- `ReferenceArea`
- `ReferenceLine`
- `Tooltip`
- `XAxis`
- `YAxis`

Use linear segments for laboratories and sparse clinical measurements.
Use monotone display curves only for dense daily or aggregated trends.

Display interpolation must not create stored values.
Tooltip values always come from real points or labelled aggregates.

Set `connectNulls={false}`.
A null value breaks the line.

Use each chart's newest point as the time-domain end.
Do not extend a Point Measurement to today.

Use effective-period bars for Stateful Facts.
Use a dashed line or area for Explicit Estimates.

Use dated neutral bands for source ranges.
Use separate indigo dashed lines or bands for Personal Goals.

Do not reuse the newest source range for old points.

Use compact neutral grids and axes.
Hide unnecessary grid lines.

Use custom tooltips with:

- Exact local date and time
- Value and display unit
- Original source value and unit when converted
- Data Source
- Source range for that point
- Personal Goal when applicable
- Source Interpretation
- Aggregate method when applicable

Use status dots and callouts sparingly.
Do not place status color on every point.

## Chart sizes

Use these default heights:

- Sparkline: 48 pixels
- Compact card trend: 160 pixels
- Standard chart: 240 pixels
- Detailed chart: 320 pixels
- Timeline or comparison chart: 420 pixels

Mobile charts use at least 220 pixels of height when axes or tooltips need space.

Charts can define a minimum content width.
Their container owns horizontal scrolling.

## Chart density and transforms

Show original points for sparse sources.

Aggregate dense sources only when the metric contract allows it.
Label the method beside the chart.

Examples include:

- Daily sum
- Daily mean
- Seven-day moving mean
- Weekly mean
- Monthly total

Never hide the original series permanently.
The detailed view must expose the underlying points or a data table.

Each section chooses its default time window.
The Owner's last choice persists for that section.

## Chart interaction

Pointer, keyboard, and touch must expose the same facts.

Desktop charts support:

- Hover tooltips
- Focusable points
- Arrow-key point movement
- Enter to pin a point
- Escape to clear a pinned point
- Open details
- View source
- Ask Chat

Touch charts support:

- Tap to pin
- Tap outside to clear
- Horizontal pan only inside a chart that needs it
- Large hit targets around small marks

A chart supplies:

- An accessible name
- A plain-language summary
- A legend when multiple layers exist
- A Show data table action
- A no-data message

Chart animation is off by default.
It must not delay reading or change perceived values.

## Record rows

Desktop rows keep a stable scan order:

1. Record label
2. Current value or status
3. Date and age
4. Range Status
5. Source Interpretation
6. Data Source
7. Actions

Mobile rows use labelled blocks.
They keep the record label and primary value first.

The actions are:

- Open details
- View source
- Ask Chat

Rows use hover only on fine pointers.
Focus-visible uses the T3 Code two-pixel ring.

Multi-select appears only after the Owner selects one row.
Selection uses an indigo surface and a visible check mark.

## Sections and accordions

Every Health Section remains visible.
An empty section keeps its heading and shell.

Section headings can stick below the top bar on long desktop pages.
They must not cover focused content.

Accordions preserve open state during local updates.
Opening one accordion does not always close another.

Exclusive accordions are allowed only for mutually exclusive views.
Travel summary groups are one example.

Hash navigation moves focus to the section heading.
Scroll tracking changes the active item without adding history.

## Search

Use the T3 Code command dialog.
Command-K opens search.

Search covers:

- Health Sections
- Published records
- Source documents
- Exact evidence locations

Group results by type.
Show a short source and date preview.

Keyboard-opened search uses no entry animation.
Pointer-opened search can use the T3 Code 200-millisecond transition.

## Ask Chat

Ask Chat uses the T3 Code chat surface and composer.

Attached Context References appear as removable chips.
The chips show record type, label, date, and source.

Ask Chat never sends automatically.
Chat history preserves attached Context References.

On wide desktop screens, Chat can open in a right panel.
On smaller screens, Chat opens as its main surface.

Closing Chat returns to the prior scroll position and focused record.

## Source evidence

View source opens an in-app evidence viewer.

Desktop uses a right sheet or full viewer.
Mobile uses a full-height sheet.

The viewer highlights the exact page, region, cell, frame, or text span.
Original download stays available as a secondary action.

Source badges use a shared registry.
Unknown providers use a neutral fallback icon and their source name.

No section layout can depend on a fixed provider list.

## Integration readiness

Version one shows Upload files instead of Connect provider.

The shell reserves a Data Sources destination under More or Settings.
It can later show file imports and direct integrations together.

Source selectors read from source metadata.
They do not use provider-specific component branches.

New integrations can add:

- A source icon and label
- Connection state
- Last sync time
- Coverage dates
- Import warnings
- Refresh and disconnect actions

Adding a provider must not require:

- A new Health Section
- A new chart component
- A new record-row layout
- A provider-specific status language
- A provider-specific storage identity

## Loading and partial states

Every section reserves its final layout while loading.
Use fixed-height T3 Code skeletons.

Skeletons show the expected card and row structure.
They do not draw fake health values.

Expose an accessible loading label.
Do not announce every skeleton item.

A partial state shows available data.
It adds one compact explanation near the affected group.

Pending Record Candidates never appear as published values.
Their count links to Uploads.

## Empty states

Keep empty states compact.
Do not use large illustrations.

An empty state states:

- What is missing
- Which file types can add it
- Where Uploads opens

Never imply that missing data proves good health.
Never suggest direct provider sync in version one.

## Error states

Keep errors local when other sections can work.

An error shows:

- What failed
- Whether displayed data is older
- Last successful update time
- Retry action
- Uploads or source link when useful

The full page error appears only when the shell cannot load.

## Controls

Use T3 Code Base UI controls and variants.

Fine pointers use compact 28 to 36-pixel visible controls.
Coarse pointers get at least a 44-pixel hit area.

Every control supports:

- Default
- Hover
- Active
- Focus-visible
- Disabled
- Loading when an action can take time

Destructive actions need clear text and confirmation.
Routine navigation must not use confirmation.

## Keyboard access

Use these shortcuts:

- Command-K: Search
- Command-/: Ask Chat
- Escape: Close the active sheet, dialog, tooltip, or selection mode

All actions remain available without shortcuts.

Use natural document order.
Do not create a custom tab order.

Restore focus to the trigger after a dialog or sheet closes.
Restore focus near the prior record after route changes.

## Motion

Health is a professional dashboard.
Motion stays crisp and rare.

Do not animate:

- Keyboard-opened search
- Keyboard section navigation
- Chart series on load
- Repeated row selection
- Live metric updates

Use 100 to 160 milliseconds for press feedback.
Use 125 to 200 milliseconds for tooltips and small popovers.
Use 200 to 300 milliseconds for sheets and dialogs.

Use strong ease-out for entry and exit.
Use ease-in-out for movement that stays on screen.
Never use ease-in for interface motion.

Animate only transform and opacity.
Use interruptible transitions for changing interface state.

Button press scale can reach 0.97 on fine pointers.
Do not scale health cards on hover.

Reduced motion keeps opacity and color transitions.
It removes position changes, chart drawing, parallax, and large scaling.

Theme changes suppress all transitions.

## Accessibility

Meet WCAG 2.2 AA.

Text and controls must pass contrast in both themes.
Charts must remain readable with color-vision differences.

Do not use color alone.
Use labels, dash patterns, point shapes, and icons.

Interactive elements must:

- Use semantic HTML
- Expose accessible names
- Show focus
- Work with keyboard
- Use 44-pixel coarse-pointer targets

Announce saved changes, local errors, and completed retries.
Do not announce scroll-driven active navigation.

Tables use real headers.
Accordions expose state.
Dialogs and sheets trap focus and restore it on close.

## Acceptance boundary

The dashboard is not complete if it drops a Helix health section or dashboard interaction.

The dashboard is not complete if mobile hides records available on desktop.

The dashboard is not complete if a chart lacks evidence, accessible data, or visible gaps.

The infrastructure is not complete if adding a provider requires a new section or record shape.

Version one can omit live provider connection flows.
It cannot block their later addition.
