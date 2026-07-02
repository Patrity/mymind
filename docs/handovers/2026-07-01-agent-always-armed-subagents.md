---
title: Always-armed agent + proactive memory injection + specialist subagents — Cycle 42
cycle: 42
date: 2026-07-01
status: built + gates green (typecheck 0 / 718 tests / build) + live browser E2E PASS (toggles gone; search_brain chip "(5 tool calls)" + digest reply; exec approval prompt → approve → clean fail-closed on non-root dev)
branch: master (direct; follows cycle 41 in the same session — Tony-directed scope, no separate spec)
docs:
  - ../wiki/agent.md (entry point, Subagents section, tuning)
  - ../wiki/agent-exec.md (always-armed gate model, WS frame retirement, security posture)
  - ../superpowers/plans/00-roadmap.md (cycle-42 row)
problem: >
  Three Tony-directed improvements from the cycle-41 audit follow-up: (1) the dual-enable exec lever
  ("Powerful tools" + "Exec enabled" switches, profile frame, cookie) added friction and a prompt/tool
  mismatch risk — Tony wants the agent FULLY ARMED at all times; (2) memories only reached the model if it
  chose to call search_memories — helpfulness needs proactive, fast injection of top-relevant memories every
  turn; (3) deep digging (web research, brain search) dumped raw multi-step tool results into the main
  conversation context — needs specialized, narrow-context subagents with steering prompts.
keydecision: >
  "Fully armed" moves safety from AVAILABILITY to EXECUTION: exec is exposed on every turn, but it remains
  dangerous:true so every call is allowlist-or-approve, and channels with no approval UI (headless SSE, MCP)
  auto-deny. Subagents are FIXED SPECIALIST TYPES (not a generic spawner) — a 35B-A3B orchestrator compounds
  planning errors with free-form delegation; narrow toolsets + no subagent-in-subagent make recursion
  impossible by construction. Memory injection is best-effort and bounded (1.5s timeout, relevance floor,
  never throws) so it can never block or break a turn.
shipped:
  - "**Always-armed profile**: ONE `bridgetProfile` = agentTools + execTool + subagentTools (profile.ts). `powerfulProfile`/`profileById`/`effectiveTools` deleted; `ctx.execEnabled` removed from runAgent; `{type:'profile'}`/`{type:'execEnabled'}` WS frames silently ignored; 'Powerful tools' + 'Exec enabled' switches and the `agent-exec-enabled` cookie removed from /agent; `setProfile`/`setExecEnabled` removed from useVoice. VOICE_TUNING.agent collapses to a single maxSteps:16. Exec prompt guidance is now always in the system prompt (SHELL block)."
  - "**Proactive memory injection**: `buildMemoryContext(userText)` (agent/context.ts) — searchMemories top-5, relevance floor 0.2, 1.5s timeout, returns '' on any failure. Injected per turn in handleTurn as a labeled 'Possibly relevant memories (background…)' block appended to the context. Wired at the WS boundary (ws.ts passes the real builder; orchestrator unit tests omit it → hermetic + fast, after a first attempt with a static orchestrator→services/memory import ballooned suite import time and flaked two slow tests)."
  - "**Specialist subagents** (agent/subagents.ts): makeSubagentTool factory → nested runAgent with narrow toolset + own system prompt + own maxSteps (new ctx.maxSteps override), returns {report} + a tool-chip summary with tool-call count. Two instances: `research_web` (web_search+web_fetch, 10 steps, researcher prompt: multi-angle queries → fetch 2–3 sources → cited digest ≤350 words, honest on degraded backend) and `search_brain` (11 read tools over memories/docs/passages/projects/tasks, 8 steps, librarian prompt: multi-angle search → read relevant sections → digest with paths + explicit gaps). Dynamic import of run.ts breaks the run→profile→subagents module cycle. On the PROFILE, not agentTools → invisible to MCP (test-guarded)."
  - "**Prompt (test-guarded)**: DELEGATE rule (when to use research_web/search_brain, 'they cannot see this conversation — pass facts in context'); SHELL block always present; exact date/time line `nowLine(now)` (weekday, date, time, timezone) alongside the tone line; knowledge-cutoff steer folded into the web-research rule."
  - "**Per-turn live context**: ws.ts rebuilds buildLiveContext every turn (the once-per-connection cache went stale mid-conversation); ConnState.context/profile/execEnabled fields removed."
  - "**Tests**: subagents.test.ts (drain/report/task+context passthrough/maxSteps/no-recursion); agent-memory-context.test.ts (formatting, floor, never-throws, handleTurn injection + no-memories passthrough); prompt tests updated (always-armed exec, delegation, nowLine); mcp-dangerous extended (subagents absent from MCP); obsolete effectiveTools tests removed; mem-dedup dynamic-import test given a 15s timeout (observed 5s-flake under parallel import load)."
verification: >
  typecheck 0; vitest 718/718; production build clean. Browser E2E on dev /agent: toggles gone from both
  navbars; a normal chat turn works; a search_brain delegation turn produces an inline subagent chip and a
  digest-based reply; exec prompts for approval (gate intact).
deferred:
  - "Structural tool-history (now Cycle 43 task) — unchanged: the model still never sees its own prior tool calls across turns."
  - "An `executor` subagent (exec inside a subagent) — approval-channel threading through nested runs; skipped this cycle, main agent has exec directly."
  - "Subagent progress streaming — nested tool events don't surface live in the UI; only the final chip summary (with tool-call count) does."
  - "Serving-side generation_config parity (top_p/top_k) on the rig; only temperature is pinned app-side."
---

# Always-armed agent + memory injection + subagents (cycle 42)

Tony's direction after the cycle-41 audit: kill the "Powerful tools"/"Exec enabled" levers (agent fully armed,
approval gate = the safety), inject top relevant memories programmatically every turn, and add specialized
subagents with narrow toolsets + steering prompts so deep digging happens off the main context.

All three shipped — see frontmatter. The security posture change is deliberate and documented in
wiki/agent-exec.md: availability is universal, execution is per-command gated, no-approval-UI channels
auto-deny, allowlisted patterns still run unattended (keep the allowlist tight).

## Post-ship fix (same day): "researched: no report"

First prod use: `research_web` ran 22s, made ~12 successful searches/fetches (prod activity_log spans), then
**hit its 10-step cap mid-tool-loop** — the AI SDK stops the run right there, so the subagent never got a
step to write its digest → empty report. (Bridget's fallback behaviour was correct: she said so and searched
directly.)

**Fix — final-step guarantee in `runAgent`:** `prepareStep` forces `toolChoice: 'none'` on the LAST allowed
step (`stepNumber >= maxSteps - 1`), so NO run — subagent or main loop — can ever end on a tool call with no
text. Plus budget guidance in both subagent prompts ("~2 steps searching, ~2 fetching, then WRITE — the final
step forces you to write") and the no-report summary now includes the tool-call count. Guard test in
test/run-agent.test.ts. Live-verified on dev: `researched: … (7 tool calls)` + a real digest; the degraded
search backend during the test also proved the warning chain end-to-end (Bridget reported "live web search is
unavailable" and labeled her MSRP answer as training data). Deployed (d12a6b9).

## Post-ship fix #2 (same day): agent DoS'd its own search backend chasing bot-walled data

Live incident #2 (prod spans): **32 searches + 20 fetches in <4 minutes** re-benched every SearXNG engine
mid-conversation — while chasing eBay sold-listing prices, which are unreachable by design (not in search
snippets; eBay 403s all bot fetches — six 403s didn't stop it).

**Fixes (3226479, deployed):** (1) searxng provider burst protection — module-level 10-min TTL query cache
(normalized de-dupe; degraded empties NOT cached) + 1.1s pacing gate serializing outbound requests across all
provider instances; (2) prompt rules (test-guarded): diminishing returns (2–3 good queries then change
strategy; bursts rate-limit the backend for the whole conversation) + marketplace bot walls (sold-listing/
price-history data needs APIs we don't have; ONE 403 from such a domain = stop touching the domain; label
tracker-based estimates as not-from-sold-listings); (3) web_fetch description + researcher subagent prompt
carry the domain-level 403 rule. Option for later: a Brave Search API key in /settings → Search as a
rate-limit-immune provider (the brave provider lane already exists).
