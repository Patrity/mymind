# MyMind
A personal tool to centralize Tony's document management, memories, project and task tracking, and provide a centralized entry point to all of it.

## Read first

Before starting any work, read [`docs/superpowers/plans/00-roadmap.md`](docs/superpowers/plans/00-roadmap.md) (the cross-cycle master roadmap: sub-projects, status, and locked global decisions), then read all of the handover frontmatter and the most recent handover in [`docs/handovers/`](docs/handovers/) — that's the source of truth for what shipped, what was deferred, and where the next seam is. Per-cycle specs live in [`docs/superpowers/specs/`](docs/superpowers/specs/) and per-cycle plans in [`docs/superpowers/plans/`](docs/superpowers/plans/).

This project is built as a sequence of **sub-project cycles** (one per major system): brainstorm → spec → plan → build → handover → update roadmap + wiki. See the roadmap for the cycle list and ordering.

Domain-specific guidance is loaded automatically as you touch the relevant files — project skills under `.claude/skills/` 

Path-scoped **rules** under [`.claude/rules/`](.claude/rules/) inject the relevant constraints + skill pointers automatically by file glob (e.g. editing a `.vue` file enforces Nuxt UI.)
**Rules carry direction/when/constraints; skills carry the actions/how-to.** When a recurring lesson or constraint emerges, add or update a rule here (see the self-improvement rule below).

## Commands

- Always `pnpm` (never npm/yarn). From repo root: `pnpm dev`
- Use `playwright-cli` to do full E2E testing
  - Create a test account when necessary
- `pnpm typecheck` frequently
- `pnpm build` to ensure builds pass
- `pnpm db:migrate` to migrate the local env (this should be done in CI for prod)

## Deploy
Homelab (Proxmox + Docker), internet-exposed. Full instructions: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). Artifacts: `Dockerfile`, `docker-compose.prod.yml`, `.env.example`.

## Rules
- YOU ARE **RELENETLESSLY** SELF-IMPROVING
  - Update CLAUDE.md proactively and as-needed, but try to keep it concise. Use rules for directory-specific or filetype-specific context injection
  - proactively create rules and skills to adapt to our workflows as new patterns are discovered or issues are overcome.
  - update skills and rules when a deviation in our documentation fails
  - use memories religiously
  - ensure that we create/update handover docs proactively in `./docs/handovers/`
    - Create them as an implementation is done, before user hand-off
    - Update them through user acceptance
    - ALWAYS ensure accurate frontmatter
  - keep the wiki (`docs/wiki/`) in sync with shipped code — the wiki is the living "how this system works **today**" reference (one page per system)
    - when you ship or change a system, update its wiki page in the SAME change (bump the `status` ladder, write the real schema/config/endpoints), and add a page for any new system
    - code + the newest handover are truth; the **spec** holds intent (frozen at brainstorm time), the **wiki** holds current behaviour — never let a wiki page describe shipped work as unbuilt (stale pages have misled past sessions)
- Always validate your web work with `playwright-cli` NOT MCP