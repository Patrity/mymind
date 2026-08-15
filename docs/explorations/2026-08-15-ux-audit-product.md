---
title: UX audit part 2 — product-level findings (flows, IA, conceptual model)
date: 2026-08-15
type: exploration
status: findings-only
method: playwright-cli, traced flows end-to-end rather than page-by-page
supersedes-emphasis-of: 2026-08-15-ux-audit.md (that one is surface/a11y; this is the product)
---

# UX audit, part 2 — the product-level problems

Part 1 audited surfaces. This one traces **flows**: what is the app for, what does a
person come here to do, and where does the UI fight them. Every claim below was
reproduced against dev data.

CLAUDE.md states the goal: *"centralize Tony's document management, memories, project and
task tracking, and provide **a centralized entry point to all of it**."* Most findings
here are the gap between that sentence and what the app does.

---

## P1. There is no entry point — the front door is a text editor

`/` redirects to `/documents`. `documents.vue` then restores a `mm.lastDoc` cookie and
reopens the last file you had open. So the "centralized entry point to all of it" is
**the last markdown file you were editing**, or, if none, the words *"Select a document
to edit."*

What the app already knew at that exact moment, and showed nowhere:

| Signal | Value |
|---|---|
| Memory conflicts awaiting your decision | **13** |
| Unreviewed memories | **15** |
| Unacked activity events | **41** |
| Most recent error | `embeddings:all-failed`, **2026-08-06** (9 days ago) |

Embeddings failing wholesale is a fatal condition for a semantic-search-based brain, and
it surfaced as a small grey `41` next to a nav item. Nothing greeted the user with it.

The app has seven content types (documents, memories, tasks, projects, sessions, images,
clipboard) and lands you inside exactly one of them, in edit mode, on a single file.

**What's missing:** a home/today view — what arrived since last visit, what needs a
decision (review queue, unreviewed memories), what's broken (errors), what you were last
working on, recent captures. Every one of those is already a live query; the sidebar badge
counts prove it.

## P2. Nothing gets named, so browsing is dead and search is the only way back

I ran the core loop of a second brain: capture a thought, then find it again.

Captured on `/capture`: *"Remember the Postgres connection pool maxes out at 20 for the
homelab box."* The app saved it as:

```
/input/9O8RQk4EOZ.md
```

A random 10-character slug. In the document tree it renders as `9O8RQk4EOZ.md`, truncated
by the narrow pane to `9O8RQk…`. Its neighbours in `/input/` — the capture inbox — are:

```
9O8RQk4EOZ.md
Transcribed note
Transcribed note
```

Three items, none of which say what they contain, two of which are identical.

The pattern holds across every browse surface:

| Surface | State |
|---|---|
| `/input/` documents (all user captures) | **3 of 3** machine-named |
| `/documents` well-named files | the 6 agent-written skills — named by the *agent*, not the app |
| `/sessions` | **7 of 50** are `(untitled session)`; the rest inherit a first-message title |
| `/gallery` | tiles have no names at all, identified by thumbnail only |

Semantic search *does* find the note (⌘K on "postgres connection pool" surfaced it, with
the body text as the description). So the app is **search-only in practice**: retrieval
works, browsing doesn't. That's a real loss — browsing is how you rediscover things you
forgot you saved, which is most of the value of a second brain.

The fix already exists inside the app: `/agent/history` titles every conversation from its
first message. The same treatment (or a one-line LLM title — there's a reasoning model
assigned and enrichment already runs on memories) applied at capture time fixes the inbox.

## P3. The provider → model → assignment chain is a three-level abstraction that has
collapsed into one level, and the UI caused it

Onboarding presents three steps — **Providers** ("where models run") → **Models** ("define
models") → **Assign** ("reasoning + embeddings") — and Settings mirrors them as three
sibling pages with no indication that they're a chain, and no explanation of what a
provider is *for*.

Here is the actual saved config:

**Providers** (supposed to be *where models run*):
```
reasoning, embeddings, vision, stt, tts_kokoro, tts_chatterbox, Anthropic
```
Six of seven are named after **roles**, not locations. And two of them are the same server:

```
http://192.168.2.25:8004/v1  →  provider "reasoning"  AND  provider "vision"
```

**Models** (supposed to be *what to run*):
```
reasoning: qwen3.6-35b-a3b
bulk:      qwen3.6-35b-a3b
vision:    qwen3.6-35b-a3b     ← the same model id, registered three times
embeddings: qwen3-embedding-4b
stt: …  tts: kokoro  tts: chatterbox  Haiku 4.5
```

**Assignments** (level 3) then map roles → those model records.

So the role concept is encoded at all three levels. One vLLM box running one model
required two provider records and three model records, and swapping that model means
editing it in three places. Adding a role means another duplicate set.

This isn't a user error — it's what the UI teaches. A person who needs reasoning walks the
stepper and creates a provider called "reasoning", a model called "reasoning", and assigns
it to "reasoning". Nothing on any of the three pages says a provider is meant to be
reused, or shows which models live on a provider, or warns that two providers share a URL.

**What's missing:** show the chain as a chain. One page, or three pages with the
relationship visible — provider cards that list the models on them, a model form that
picks its provider from a dropdown, and role assignment that reads
`reasoning → qwen3.6-35b-a3b (on 192.168.2.25:8004)`. Dedupe hints when a base URL repeats.
Right now `/settings/providers` is the only page in the app where the model of the domain
is actively misleading.

## P4. Four inboxes, three logs, three memory surfaces — the sidebar is a list of
implementations, not of jobs

14 flat nav items, no grouping. Overlaps a person has to resolve on their own:

**"I want to put something in"** → Capture (a note), Clipboard (text/files across
devices), Documents (New document), Gallery (Upload). Four doors, no stated difference.
A captured note becomes a document in `/input/`; a clipboard item does not. Nothing says so.

**"I want to see what happened"** → Sessions (ingested Claude Code transcripts), Activity
(system events + errors), Analytics (usage/infra charts), and Agent → History
(conversations with the built-in agent). Four places, and one of them isn't in the sidebar.

**"Conversations"** are split across two stores with three names: `/sessions` is titled
**Sessions**, `/agent/history` is titled **Conversations**, and it's reached by a button
labelled **History**. Both are "an AI conversation with messages and a transcript." The
one that's hidden is the one with good titles.

**"Memory"** → Memory (list, with an *Unreviewed only* filter), Review (a conflict queue),
Galaxy (a 3D graph of memories + documents + images + sessions). "Review" happens in two
places meaning two different things: unreviewed *memories* on `/memories`, and memory
*conflicts* on `/review`.

**Projects is the real dashboard and it's filed as a peer.** `/projects/[slug]` already
shows exactly the cross-cut a person wants — stat tiles plus Sessions / Tasks / Memories /
Documents tabs for one project. That's the shape the missing home page should have.

**Naming:** nav says "Memory", the page says "Memories". "Galaxy" and "Bridget" say nothing
about what they do. "Activity" means system-event-log in the nav and last-touched-date on
project rows.

## P5. The Review queue doesn't give you what you need to decide

13 conflicts, each asking you to adjudicate between two memories. The card gives you: the
new text, the existing text, an LLM reasoning paragraph, a confidence %, and one timestamp.

It does **not** give you: when each memory was created, where each came from, or which
project each belongs to — even though `/memories` renders exactly that (a PROVENANCE block
with the source session). To judge "is the new one right?" you need to know which is newer
and where each came from. The page withholds it.

Also:
- The two options aren't symmetric. **"Keep both"** (neutral ghost) vs
  **"Accept (archive old)"** (red/error). Accept *what*? The real choice is "keep both" vs
  "replace the old one." And the destructive-red styling is on the action you usually want.
- No progress — 13 items, no "3 of 13", no sense of finishing.
- No undo. `acceptConflict` archives a memory and shows a toast with no Undo action; the
  toast is the natural place for it.
- No keyboard path. A triage queue with 13 binary decisions needs j/k + a/k, not a
  mouse round-trip and a full list refetch per decision.

## P6. Smaller things that are still product problems, not polish

- **`/capture` doesn't say where anything goes.** No project picker, no folder, no
  confirmation you can act on — the toast shows `/input/9O8RQk4EOZ.md`, which is not a
  useful destination to a human. Capture is supposed to be the lowest-friction door into
  the app and it's the one that produces the least findable output.
- **`/agent` has no empty state.** A fresh chat shows a 70%-width particle visualiser and
  a blank panel. It never says what the agent can do, what tools it has, or offers a
  starting prompt — despite Settings listing its tools and skills in detail.
- **`/galaxy` opens with six developer tuning sliders** (cluster spread, glow, link
  opacity…) as its primary UI, and no answer to "what am I looking at" — no node count, no
  legend of what proximity means.
- **`/activity` logs the app's own fetches** (`/api/memories/count`, `/api/review/count`,
  `/api/_nuxt_icon/lucide.json`) at the same weight as `embeddings:all-failed`. The one
  event that mattered in nine days is in the same undifferentiated stream as icon requests.
- **Projects accumulate duplicates with no reconciliation.** Live data has `mymind`
  (github.com/tony/mymind) *and* `My Mind` ("the app"), plus `Fix Test Renamed` and
  `E2E Cycle 4` test detritus. There's a Merge flow on the detail page, but nothing
  surfaces "these two look like the same project."

---

## If I had to pick five

1. **Build a home.** `/` should answer "what needs me?" — review queue, unreviewed
   memories, errors, recent captures, last-touched work. The data is already there.
2. **Title things at capture time.** Derive a name from content (LLM or first line) for
   captures and untitled sessions. This turns the inbox from unusable to browsable.
3. **Rebuild the provider/model/assignment UI to show the chain**, and stop the app from
   teaching one-provider-per-role.
4. **Group the sidebar by job** (Capture / Work / Recall / Observe / Settings) and merge
   the duplicate concepts — one conversations surface, one activity surface.
5. **Give Review what it needs to decide** — provenance and dates per memory, symmetric
   buttons, progress, and undo.
