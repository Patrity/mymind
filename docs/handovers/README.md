# Handovers

One handover per cycle (and per significant resumable milestone). The **newest** handover is the source of truth on resume.

Naming: `YYYY-MM-DD-<topic>.md`

Required frontmatter:
```yaml
---
title: <cycle / milestone name>
cycle: <roadmap cycle #>
status: in-progress | shipped | accepted
date: YYYY-MM-DD
shipped: [ ... what actually landed ... ]
deferred: [ ... what was punted, and to where ... ]
next_seam: <where the next session should pick up>
---
```

Created when an implementation is done (before user hand-off) and updated through user acceptance. Always keep frontmatter accurate — the roadmap and future sessions trust it.
