# MyMind Wiki

The **living** reference for how each shipped system works **today** — one page per system.

- A page is created when its system is first built, and updated in the **same change** that ships or alters the system.
- Each page carries a `status` ladder: `planned → in-progress → shipped`.
- The wiki holds **current behaviour** (real schema, config, endpoints). Intent at design time lives in the per-cycle spec under [`../superpowers/specs/`](../superpowers/specs/); what happened in a cycle lives in [`../handovers/`](../handovers/).
- Never let a page describe shipped work as unbuilt.

## Pages

| System | Page | Status |
|---|---|---|
| Auth (session + API tokens) | [auth.md](auth.md) | planned |
| AI model providers (env, OpenAI-spec) | [ai-providers.md](ai-providers.md) | planned |
| Document spine (model, browser, editor, sharing, search) | [document-spine.md](document-spine.md) | planned |
| _Enrichment, Quick Capture, Image Hosting, Tasks/Projects, Memory, Clipboard_ | _created when their cycle starts_ | planned |
