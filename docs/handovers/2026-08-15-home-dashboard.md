---
title: Home dashboard — the app's front door (cycle 56)
cycle: 56
date: 2026-08-15
status: >
  ✅ MERGED to `master` locally (fast-forward `98e6111..adcccda`, 19 commits) on 2026-08-15,
  after a whole-branch review by Tony and one fix wave. **NOT pushed, NOT deployed** — master
  is 22 commits ahead of `origin/master`, so CD has not run and migration **0032**
  (`messages_created_at_idx`) has NOT been applied to prod.
  Ten build/doc tasks, all per-task reviews clean after their fix rounds; the final
  whole-branch review returned "with fixes" and all of them were applied and re-reviewed clean.
  Gates re-measured ON THE MERGED master: **typecheck 0 errors / test 1159 passed across
  150 files / build clean**.
branch: feat/home-dashboard (merged and deleted)
spec: ../superpowers/specs/2026-08-15-home-dashboard-design.md
plan: ../superpowers/plans/2026-08-15-home-dashboard.md
docs:
  - ../wiki/home.md (new page, status "shipped (unmerged)") — mirrored to MyMind at
    /projects/mymind/wiki/home.md
  - ../superpowers/plans/00-roadmap.md (cycle 56 row added)
  - ../BACKLOG.md (four deferred UX-audit findings recorded as named follow-ups)
task: 071804bd-62e2-42fa-bdc3-984235cfe227 (MyMind)
---

# Home dashboard (cycle 56)

Replaces `/`'s redirect to `/documents` (which reopened the last-open markdown file as the
app's front door) with a real dashboard: a metrics strip, an interleaved "what happened"
timeline, and five actionable rail panels, all served by one endpoint. Full architecture,
data model, and current behaviour are in [`../wiki/home.md`](../wiki/home.md) — this document
is about how the cycle went, not what the system does.

## Read this first: two plan defects, both consequential

**1. `/` was redirected in TWO places, and the plan only named one.** `app/pages/index.vue`
was the redirect the brief pointed at — but `nuxt.config.ts`'s `routeRules` also carried a
`'/': { redirect: '/documents' }` entry the brief never mentioned. A `routeRules` redirect
pre-empts the page component entirely at the Nitro/router level, so rewriting only the
component would have shipped a dashboard that was **completely unreachable** — every visit to
`/` would still 302 to `/documents` regardless of what `index.vue` contained. Task 9's
implementer found this while wiring the page assembly, removed the routeRule, and flagged it;
Tony confirmed keeping the removal. If you're auditing this branch, verify
`nuxt.config.ts`'s `routeRules` has no `/` entry — only `'/voice': { redirect: '/agent' }`
should remain.

**2. The plan specified a component that doesn't exist.** The range-switch spec called for
`UButtonGroup`; the installed Nuxt UI v4 renamed it `UFieldGroup`. Task 9's implementer
swapped it (plus a related `onClick` return-type typecheck fix). This is exactly the failure
mode the plan's own process rule exists to prevent — every task brief says "invoke
`nuxt-ui-docs` before writing component markup" — and it still slipped through because the
*plan*, not the implementer, skipped that step when it was written.

Neither defect was caught by typecheck, test, or build. #1 would only surface as "the
dashboard doesn't load" in a browser; #2 typechecks fine as a prop-name string until Nuxt UI's
component resolver fails to find `UButtonGroup` at runtime.

## What shipped

One endpoint (`GET /api/home?range=`, `server/services/home.ts`) fanning out six DB-backed
panel queries in parallel; a pure unit-tested timeline merge/group/cap
(`server/lib/home/timeline.ts`); a third range vocabulary (`HomeRangeKey`, deliberately not
shared with cycle 44's `RangeKey` or cycle 55's `UsageRangeKey`); nine new components under
`app/components/home/` plus the page at `app/pages/index.vue`; `['home']` joining the
cycle-21 live bus across nine `ResourceName` members, trailing-debounced at 700ms; migration
`0032` (`messages_created_at_idx`, closing a sequential-scan gap cycle 55's handover had
already flagged); `getUsage()` split into a thin wrapper over a new `getUsageSince(Date)` so
Home can query the usage tables without widening cycle 55's range enum; and a `?q=` param on
`/agent` that prefills (never auto-sends) the composer via a new optional `initialText` prop.
Full detail in the wiki.

## The review loop — what it actually caught

Ten tasks, subagent-driven, per-task two-verdict review + fix rounds where needed. This was
not a clean run — five of nine build tasks needed at least one fix round, and two separate
scope escalations went to Tony mid-flight. In order:

**Pre-flight (before Task 1).** The plan itself failed a defect scan before any code was
written: `RigHealth`'s brief used `{name, up: boolean}` where the real `ServiceHealth` type is
`{id, label, up: boolean | null}` (`null` means *no data*, not *down* — collapsing that would
have mis-rendered "unscraped" as "failing"); a constructed `bg-${r.color}` class would have
been purged by Tailwind's static scanner; Task 3's step 4 showed two conflicting refactors in
sequence; Task 8 wrote a `.replace('memorys','memories')` hack and then, in the same brief,
said to fix it; Task 4's `metrics()` snippet `sql.raw`'d table identifiers (a needless
injection-shaped pattern for names that are never variable); and the plan's own Nuxt UI
constraint text read as if it banned layout `<div>`s outright. All six fixed by the controller
before Task 1 started.

**A plan-vs-rubric conflict, escalated before build started.** The plan's original task order
had Task 6 assembling `index.vue` against five components Tasks 7–9 hadn't built yet, leaving
`/` in a broken state across three consecutive tasks. Raised with Tony; ruling was to
**reorder** — page assembly moved to the end of Task 9, after every component it references
already exists. No reviewer was ever asked to sign off on a knowingly-broken `/`.

**Task 1 (DTOs + range).** Clean. One deferred minor: the implementer's own report misstated
its file line counts (95/42 vs. the actual 101/36) — the diff is authoritative and was
correct; only the implementer's self-report was wrong.

**Task 2 (timeline).** Clean. One deferred minor worth flagging forward: the test file
interpolates hours unpadded (`` T0${i} ``), so under the brief's *own prescribed* mutation
check (`COLLAPSE_THRESHOLD → 99`) any hour ≥10 builds an invalid ISO string and the test
throws before its real assertions run. The reviewer hand-traced a non-crashing mutation
(threshold→4) and confirmed coverage isn't actually compromised, but the fixture itself is
fragile and the prescribed mutation evidence is misleading. Not fixed — flagged for whoever
next reviews the whole branch.

**Task 3 (usage split + index).** Clean. Reviewer diffed the full migration snapshot
table-by-table and confirmed the *only* change is `messages_created_at_idx` — no unrelated
schema drift, `getUsage`'s signature byte-identical, existing comments preserved. Deferred
minor: the migration file lacks a trailing newline (a pre-existing drizzle-kit inconsistency
across this repo's history, not introduced here).

**Task 4 (the single endpoint) — 2 Important findings, one fix round.** Both were defects in
the *plan's own SQL*, not implementer deviations: (1) the images queries omitted `deleted_at
is null` while every other soft-deletable source in the same file filtered it — soft-deleted
images were still counting in the metrics tile and still rendering as timeline rows; (2) the
`recentProjects` four-branch `touched` CTE had no per-source cap, unlike `timelineEvents`'
`PER_SOURCE_LIMIT = 200` two functions away in the same file — an unbounded aggregation
sitting on the app's landing page. Escalated to Tony (plan-mandated correctness findings are
escalated, not fixed silently); ruling was fix both. Fix round 1 addressed both plus two
co-located minors (a dead `touches` column, an undocumented `created_at` vs.
`coalesce(completed_at, created_at)` asymmetry). Live evidence for the images fix:
`metrics.images.total` moved 34→32 at `range=30d` (the two soft-deleted rows). Two deferred
minors from this task: the DB test for range-invariance asserts against ambient dev-DB state
rather than seeded fixtures (passes today, would be toothless on an empty Postgres); and
neither Task 4 fix got its own regression test — `home-endpoint.db.test.ts` is unchanged and
the implementer substituted manual playwright live-fetch evidence instead. Both flagged
forward. One accepted residual: the per-source cap in `recentProjects` is global-across-all-
projects, not per-project — a project only drops out of a source's top-200 if 200+ *more
recent* rows from *other* projects exist in the same window; the reviewer read the ordering
and judged this unlikely at this app's scale.

**Task 5 (live invalidation) — 1 Important, not plan-mandated, one fix round.** The
implementer raised the *global* vitest `testTimeout` from 5000→10000 in `vitest.config.ts` — a
file entirely outside the brief's declared scope — to accommodate one slow sequential test.
That weakens hang-detection across all 150 test files for one file's convenience, and a
narrower instrument already existed (vitest 4.1.8's per-test timeout as `it()`'s third arg).
Fix round 1 reverted `vitest.config.ts` byte-identical and applied a 15000ms timeout to only
the one slow test. Deferred minor: the two new debounce tests use real wall-clock timers with
a 60ms margin rather than the adjacent tests' `vi.useFakeTimers()` — passes today, not
strictly deterministic under CI load.

**Standing ruling from Tony, issued after Task 5** (applies to every task after it):
plan-mandated **accessibility** findings get fixed in-loop without further escalation.
Plan-mandated **cosmetic/polish** findings get ledgered as deferred minors for the final
review. Only correctness or scope questions still get escalated.

**Task 6 (metrics + rig health).** Spec ✅, quality Approved. One Important, plan-mandated
a11y finding: rig service badges carried their identity only in a `title` attribute — hover-
only, unreachable on touch, unreliable for screen readers. Fixed in-loop per the new standing
ruling (`stateFor()`/`labelFor()` helpers + a real `aria-label` per badge). Deferred cosmetic
minor: `MetricsStrip`'s `fmt()` renders `"1000.0k"` instead of `"1.0M"` for values in
~999,950–999,999 (the `>= 1_000_000` branch tests the raw number, not the rounded quotient).

**Task 7 (timeline row + day headers).** Clean. The reviewer independently verified the
`aria-label` propagation path through the installed `@nuxt/ui` 4.8.1 source, and confirmed
`ProjectBadge`'s `:to="null"` renders a genuine `<span>`, not the old inert-`<nuxtlink>` bug
from an earlier cycle. One adjudication, not a defect: the reviewer flagged the mobile
`MOBILE_PREVIEW = 12` client-side slice as possibly tripping the global "no re-capping in the
UI" constraint and asked for a ruling. Controller's call: the constraint's intent is no
re-grouping/re-sorting of server data; progressive disclosure that reveals every row the
server already sent isn't that. Tony's brainstorm ruling had already selected mobile
treatment 2 for exactly this reason — no further escalation needed.

**Task 8 (needs attention, active tasks, recent projects) — 2 Important, both plan-mandated,
one fix round.** Both were literal defects in the brief's own Step-1 code snippet: (1) row
labels were unconditionally plural, so n=1 rendered "1 errors unacked" — a twelfth instance of
the exact bug class the plan's own Global Constraints section names as binding; (2) the header
badge summed non-zero *categories*, not items, so 71 errors + 3 unfiled captures rendered
badge "2" — understating severity on the one panel that exists specifically because a quiet
badge let 71 unacked errors go unseen for nine days. Neither is a11y or cosmetic, so both were
escalated; ruling was fix both. Fix round 1: per-row singular/plural forms with irregulars
spelled out, badge renamed `totalItems` and now sums counts (74, not 2). Deferred minor
(accepted, additive): the implementer added a `:title` tooltip to `RecentProjects`' truncated
stats line beyond the brief's literal snippet, consistent with `TimelineRow`'s existing
pattern.

**Task 9 (page assembly + `?q=` hand-off) — 3 findings, DONE_WITH_CONCERNS, one fix round.**
This is where both plan defects above surfaced: the missing `routeRules` redirect (found and
removed, Tony confirmed) and the `UButtonGroup`/`UFieldGroup` swap. The third finding was a
real scope block, not a defect: `?q=` prefill needs a ref into the composer's text input, but
`app/components/voice/Composer.vue`'s `text` ref is private local state, outside the brief's
declared file scope. The implementer correctly stopped rather than improvising a workaround
into a working, unrelated component. Tony ruled: extend scope, add an optional `initialText`
prop. Fix round 1 added it — seeded via `ref(props.initialText ?? '')` plus a **non-immediate
watch** on `initialText` so a second Ask hand-off while already on `/agent` (same route, new
`?q=`) also lands, which the brief's simpler `onMounted`-only sketch would have missed.
Reviewer traced the "`?q=` never sends" invariant through the full 268-line `Composer.vue` and
confirmed `send()` has exactly one call site. Three deferred minors: the `initialText` watch
reseeds on any new truthy value even mid-edit, so a second hand-off while typing on `/agent`
clobbers in-progress input; the home query has no `placeholderData`, so a range switch shows
the full skeleton rather than the previous range while refetching; and the two new inputs'
`aria-label`s duplicate their placeholders verbatim, ellipsis included.

## Gate numbers (measured this task, at HEAD)

```
pnpm typecheck   → 0 errors
pnpm test        → 1158 passed, 150 test files, 0 failed  (8.09s)
pnpm build       → clean, exit 0 ("✨ Build complete!")
```

The plan's own self-review predicted the new suite would include `home-range`,
`home-timeline`, and `live-dispatch` tests — confirmed present (`test/home-range.test.ts`,
`test/home-timeline.test.ts`, `test/live-dispatch.test.ts`). `test/home-endpoint.db.test.ts`
exists but runs under `pnpm test:db` (real Postgres, not in this gate), matching the cycle-55
`.db.test.ts` pattern — not run as part of this handover's measured numbers.

## Browser validation (playwright-cli, this task)

**1280×800.** Screenshot read directly. Layout matches spec exactly: metrics strip
(Sessions/Memories/Documents/Tokens/Rig) across the top, "What happened" timeline in the wide
left column, "Needs attention" + Quick capture + Ask the brain + Active tasks (+ Recent
projects, below the fold) stacked in the right rail. No overlapping or clipped content
observed.

**Range invariance — the load-bearing spec check.** Clicked `1d`, read the DOM, clicked `30d`,
read again:

```
1d:  attention = ["41errors unacked","13memory conflicts to resolve",
                  "15memories unreviewed","2captures still in /input"]
     rows = 1     heading = "last 1d"
30d: attention = ["41errors unacked","13memory conflicts to resolve",
                  "15memories unreviewed","2captures still in /input"]
     rows = 12    heading = "last 30d"
```

`attention` is byte-identical across the range switch; `rows` (timeline links) went 1→12 and
the heading updated. This is the spec's central invariant — Needs Attention is absolute
backlog, never range-scoped — proven live, not just asserted from reading the code. The 30d
screenshot confirms it visually: the timeline gained day headers and rows (`embeddings:
all-failed`, three `bulk:all-failed` rows) while the "Needs attention" panel's four numbers
stayed fixed at 41/13/15/2.

**390×844 mobile.** Raw eval:

```json
{ "horizontalScroll": false, "scrollW": 390, "clientW": 390,
  "overflowing": 28, "hoverGated": 0 }
```

`horizontalScroll: false` and `hoverGated: 0` are the clean numbers the brief expects.
`overflowing: 28` needed a second pass to interpret correctly — the naive check (any element
whose right edge exceeds `clientWidth`) doesn't distinguish a true page-overflow bug from an
element deliberately living inside its own horizontally-scrollable container. Traced all 28:
every one is a metrics-strip tile or rig badge inside `MetricsStrip.vue`'s
`overflow-x-auto` row (the spec's own mobile treatment: "metrics become a horizontally
scrollable row"). A follow-up check confirmed each has a scrollable ancestor whose *own*
right edge sits within the viewport (`ancestorRight ≤ clientWidth`, confirmed at 358 ≤ 390),
and the document-level `scrollWidth === clientWidth` already proves the page itself never
scrolls sideways. **Net: 0 real page-level overflows, 0 hover-gated interactive elements** —
neither of the two named regressions (Tasks' CTA clipping ~20px off-screen; Clipboard's 16
`opacity: 0` Copy buttons) reproduces here. Screenshot read directly: metrics row scrolls
sideways with a visible partial third tile as the scroll affordance, timeline follows in full
DOM order below it. Scrolled further to confirm the rail (Needs attention → Quick capture →
Ask the brain → Active tasks → Recent projects) collapses under the timeline in the same
order, not reordered or tabbed — matches spec.

One thing checked but not required by the brief: no "Show more" control was visible in the
mobile timeline at `range=30d`, because the local corpus's 30d timeline has fewer than the
`MOBILE_PREVIEW = 12` cap — the affordance is real (read in source, `Timeline.vue`) but this
corpus doesn't have enough rows to trigger it live.

## Deferred minors carried forward (not fixed this cycle)

Everything the ledger flagged "FLAG TO FINAL REVIEW" or accepted as a residual, for whoever
does the whole-branch review before merge:

1. `test/home-timeline.test.ts` interpolates hours unpadded — breaks under the brief's own
   prescribed `COLLAPSE_THRESHOLD→99` mutation check (Task 2).
2. Task 4's two Important-finding fixes (soft-deleted images, per-source CTE cap) have no
   dedicated regression test — only manual playwright evidence.
3. The range-invariance DB test asserts against ambient dev-DB state, not seeded fixtures —
   toothless against an empty Postgres (Task 4).
4. `recentProjects`' per-source cap is global-across-projects, not per-project — accepted,
   judged unlikely at this app's scale (Task 4).
5. `MetricsStrip.fmt()` mis-renders `~999,950–999,999` as `"1000.0k"` instead of `"1.0M"`
   (Task 6).
6. The two new debounce tests use real wall-clock timers with a 60ms margin instead of fake
   timers, unlike their neighbors in the same file (Task 5).
7. `Composer.vue`'s `initialText` watch clobbers in-progress typing on a second hand-off
   (Task 9).
8. No `placeholderData` on the home query — a range switch shows the full skeleton instead of
   the previous range while refetching (Task 9).
9. The two new inputs' `aria-label`s duplicate their placeholders verbatim (Task 9).

None of these are correctness bugs in what shipped; they're either test-quality gaps or minor
UX polish, each already triaged (escalate vs. defer) per Tony's standing ruling.

## Out of scope — filed as backlog follow-ups

Four adjacent findings from the 2026-08-15 UX audit, named in the spec's "Out of scope"
section as "each its own cycle" and now recorded in `docs/BACKLOG.md`: capture titling
(`/input/9O8RQk4EOZ.md` — user captures get machine names, the inbox can't be browsed),
sidebar IA (four inboxes/activity surfaces/conversation stores under inconsistent names),
login deep-link preservation (`navigateTo('/login')` drops the intended destination), and the
document editor's silent autosave data loss (flagged as the most severe *open* bug in the
app, unrelated to Home).

## What to check before merging

- `nuxt.config.ts` `routeRules` has no `/` entry (only `/voice`).
- The nine deferred minors above — none are blockers, but a whole-branch reviewer should see
  them before signing off, not discover them independently.
- This branch has not been pushed or deployed. No migration has run anywhere but local dev;
  `0032` still needs to apply in whatever environment merges this.
