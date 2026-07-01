---
title: Agent-loop audit — transcript rendering, inline tool chips, search resilience, sampling — Cycle 41
cycle: 41
date: 2026-07-01
status: built + gates green (typecheck 0 / 709 tests / build) + probe & live-chat browser-verified + prod SearXNG fix applied & verified
branch: master (direct; surgical bugfix cycle — no spec/plan, driven by systematic-debugging off a live incident)
docs:
  - ../wiki/agent.md (transcript rendering, tuning, web-research sections)
  - ../superpowers/plans/00-roadmap.md (cycle-41 row)
problem: >
  Tony reported the agent harness as "really bad": (1) not persistent about web research, (2) the SAME assistant
  reply rendered verbatim again and again across turns, (3) all tool-use chips rendered in one block at the bottom
  of the transcript instead of inline, (4) overall "lazy" despite qwen3.6-35b-a3b benchmarking well on tool use.
  Audit verdict: the MODEL was fine — prod conversation_messages showed three DISTINCT, reasonable replies
  (the last one re-ran 7 searches) where the UI displayed one reply three times. All three symptoms were
  harness/UI/infra bugs.
rootcauses:
  - "**Repeated replies = MDC cache-key collision (UI, not model).** @nuxtjs/mdc's `<MDC>` keys its useAsyncData on `hash(props.value)` frozen at SETUP time — for a streaming entry that's the hash of the FIRST DELTA. Consecutive replies opening with the same token ('You're…') collided on one shared asyncData record, so later replies rendered the first reply's parsed content. Reproduced with a controlled 2-entry probe page; DB had distinct texts."
  - "**'Not persistent' = SearXNG blackout, silently.** The agent's ~25-query burst in one research turn rate-limited brave/ddg/startpage. SearXNG's default suspended_times bench a rate-limited engine 1h and a CAPTCHA'd engine 24h → every subsequent query returned [] and the provider DISCARDED unresponsive_engines, so the model couldn't distinguish 'nothing exists' from 'backend down'. It honestly reported 'search is unresponsive' and got called lazy."
  - "**Bottom-of-transcript chips = design gap.** Transcript.vue rendered a flat chips[] (from the global /api/agent/activity SSE) AFTER the entries v-for; the WS 'tool' events (already emitted in stream order by the orchestrator) were ignored by mapServerMessage."
  - "**Fragile decoding.** runAgent's streamText passed NO sampling params — a greedy-decoding default on the serving stack turns small local models into copy-loops. maxSteps 6 also forced research turns to stop mid-investigation and rationalize ('I have enough context')."
shipped:
  - "**Per-entry MDC cache keys**: TranscriptEntry gains a stable `id` (uuid at push; DB message id on resume); MdView accepts + forwards `cacheKey`; Transcript.vue passes `transcript-<id>`. Probe-verified: two same-prefix streamed entries now render distinctly."
  - "**Inline tool chips**: mapServerMessage maps WS `{type:'tool'}` → tool effect; useVoice pushes role:'tool' transcript entries at true stream position (they naturally split assistant text into before/after-tool bubbles); Transcript.vue renders chips inline with undo; resume() rebuilds chips from persisted toolCalls (rendered before their reply — exact position isn't stored). Bottom chips block + useAgentActivity usage removed from /agent (composable + SSE endpoint still exist, now unconsumed — candidates for the activity page or removal)."
  - "**Search degradation surfaced to the model**: SearchProvider now returns {results, warning?}; searxngWarning() sets it when results are empty AND engines are unresponsive; web_search passes the warning through (result + summary '(0, backend degraded)') and its description + a new prompt rule tell the model to STOP searching and report the outage instead of concluding the info doesn't exist."
  - "**Prod SearXNG fix (applied to LXC 114 + tracked in repo searxng/settings.yml)**: suspended_times → 60s (TooManyRequests) / 300s (Captcha/AccessDenied) instead of 1h/24h/24h; enabled bing + mojeek + qwant alongside google/ddg/brave/startpage. Verified live: the exact incident query went 0 → 20 results. Backup at /opt/mymind/searxng/settings.yml.bak."
  - "**Sampling + step budget**: streamText now always sends temperature (VOICE_TUNING.agent.temperature = 0.7, qwen3-recommended) so a greedy serving default can't cause copy-loops; maxSteps 6 → 12 (powerful stays 16)."
  - "**Prompt rules (guarded by tests)**: degraded-backend honesty; never narrate a tool call without making it in the same turn; on pushback, re-check data before conceding (anti-sycophancy)."
verification: >
  Controlled probe page (2 streamed entries, same first delta): buggy = both render FIRST reply; fixed = distinct.
  Live /agent chat in dev: 'search my memories…' turn → inline chip 'searched memories (20)' between user turn and
  reply; second turn renders distinctly. Prod evidence: conversation 7129b102 rows md5-distinct while UI showed
  duplicates; activity_log showed 25+ ok web_search spans; SearXNG /search returned results:[] with
  unresponsive_engines [brave/ddg/startpage] pre-fix, 20 results post-fix.
deferred:
  - "**Structural tool-history (the durable fix, own cycle)**: runAgent still builds model history from {role, content} text only — the model NEVER sees its own prior tool calls/results across turns (getAgentHistory drops them; s.history is text-only). Cross-turn it can't know it already searched, and history teaches it that narration produces answers. Fix: persist toolCalls WITH args+results (capped), rebuild history as proper assistant-tool-call + tool-result messages. Predicted in cycle-39's postmortem; MyMind task filed."
  - "useAgentActivity + /api/agent/activity SSE now unconsumed by /agent — repurpose for a global activity indicator or remove."
  - "getAgentHistory drops attachments on resume (multimodal context lost across reconnect) — fold into the structural-history cycle."
  - "Consider serving-side generation_config parity on the rig (top_p/top_k per qwen3 recommendation); only temperature is pinned app-side."
---

# Agent-loop audit (cycle 41)

See frontmatter for the full story. One-line version: **the model was innocent** — a streaming-markdown
cache-key collision made distinct replies render as duplicates, SearXNG silently blacked out after the agent's
own query burst (default 1h/24h engine suspensions), tool chips were rendered from a side-channel SSE feed at
the bottom instead of the in-order WS events, and the loop ran with no sampling params + a 6-step cap.

Fixed: per-entry MDC cache keys, inline tool chips at stream position, degradation warning surfaced end-to-end
(provider → tool result → prompt rule), prod SearXNG engine diversity + fast suspension recovery, temperature
pinned, step budget raised, anti-sycophancy/no-fake-narration prompt rules. All browser-verified; gates green.

Next seam: feed the model its own tool-call history as structured messages (task filed) — that's the remaining
structural gap behind "the agent doesn't remember it already searched."
