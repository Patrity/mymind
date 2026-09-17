---
name: wiki-mirror
description: Mirror docs/wiki pages to MyMind without pasting their bodies into context. Use when a wiki page changed, when frontmatter mymind_hash is stale, or when reconciling the "wiki mirrors are missing/diverged" backlog.
---

# Mirroring `docs/wiki/` to MyMind

Every wiki page carries its mirror identity in frontmatter:

```yaml
mymind_id: b7dc4979-…      # the MyMind document id
mymind_hash: 1827c6b1…     # sha256 of the BODY as MyMind last stored it
```

## The hash is checkable locally

`documents.content_hash` is a **Postgres generated column**
(`server/db/schema/documents.ts` → `doc_content_hash(content)`, migration 0030):

```sql
encode(sha256(convert_to(t,'UTF8')),'hex')
```

So it is a plain `sha256` of the stored `content` — nothing normalized, frontmatter excluded
(`hashBody` in `server/lib/agent/sync.ts`). Any route that writes `content` updates it; you cannot
write a stale hash.

That means you can predict the post-write hash locally:

```bash
python3 -c "
import re,hashlib,pathlib
t=pathlib.Path('docs/wiki/<page>.md').read_text()
m=re.match(r'^---\n.*?\n---\n',t,re.S)
print(hashlib.sha256(t[m.end():].encode()).hexdigest())"
```

## Check divergence for free

`mcp__mymind__sync_document` in **probe mode** transfers no body and never writes:

```
sync_document(id=<mymind_id>, local_hash=<sha256 of local body>)
→ { in_sync, server_hash }
```

`server_hash == mymind_hash` in frontmatter ⇒ **nobody edited it in MyMind since the last mirror**,
so writing is safe. `server_hash != mymind_hash` ⇒ a real UI edit to reconcile; read it before
overwriting.

## Write without paying context for the body

`sync_document` needs the whole body as a tool argument — 25–60 KB per wiki page, and retyping it
from context risks silent transcription errors. Use the REST route instead and pipe the file:

```bash
# mint a short-lived prod token (stored hash is sha256 of the token itself)
TOKEN="mm_$(python3 -c 'import secrets,base64;print(base64.urlsafe_b64encode(secrets.token_bytes(24)).decode().rstrip("="))')"
HASH=$(printf '%s' "$TOKEN" | shasum -a 256 | cut -d' ' -f1)
lxc "docker exec -i mymind-db psql -U mymind -d mymind -Atc \"insert into api_tokens (name, token_hash, last_four) values ('claude-wiki-mirror-temp','$HASH','${TOKEN: -4}') returning id;\""

# body-only JSON, then PUT
python3 -c "
import re,json,pathlib
t=pathlib.Path('docs/wiki/<page>.md').read_text()
m=re.match(r'^---\n.*?\n---\n',t,re.S)
pathlib.Path('/tmp/put.json').write_text(json.dumps({'content':t[m.end():]}))"

curl -s -X PUT https://brain.costanzoclan.com/api/documents/<mymind_id> \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  --data-binary @/tmp/put.json | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['contentHash'],d['path'])"
```

`PUT /api/documents/[id]` → `updateDoc` → `publishChange({resource:'document',action:'updated'})`,
the same terminal path `sync_document`'s write branch takes via `casUpdateContent`. It skips the
fail-closed CAS, which is why the **probe above is not optional**.

Then write the returned `contentHash` back into the page's `mymind_hash`, **delete the token**
(`delete from api_tokens where id = '<id>'`), and commit.

> `lxc` is the helper from the `prod-deploy` skill. The MyMind MCP points at **prod**, so the probe
> and the PUT are talking to the same box.

## Gotchas

- **A local commit that edits a wiki page does not re-mirror it.** `mymind_hash` keeps describing
  what MyMind has, so local edits drift silently. Mirror in the same change that edits the page.
- **`updateDoc` ignores `contentHash` as an input** — it is generated, so never try to set it.
- **Handovers are not mirrored**, only `docs/wiki/`. They carry no `mymind_id`.
- Standing backlog task `4dcac88d` tracks the pages that are still missing or diverged.
