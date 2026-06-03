---
title: Auth
status: planned
cycle: 1
updated: 2026-06-02
---

# Auth

better-auth with two surfaces: **session** auth for the web app (single user), and **bearer API tokens** for machine clients (ShareX/CleanShot uploads, Claude Code / Hermes hooks, MCP). The app is internet-exposed, so upload and public-share endpoints are the real attack surface (rate-limit; signed/expiring URLs for public assets).

> Status: **planned** — gets real middleware, token model, and route protection when cycle 1 ships.
