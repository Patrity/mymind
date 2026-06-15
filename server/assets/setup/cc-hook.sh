#!/usr/bin/env bash
# mymind cc-hook — POSTs Claude Code session events + transcript deltas to MyMind.
# Install: curl -fsSL "$MYMIND_URL/api/setup/cc-hook" -o ~/.mymind/cc-hook.sh && chmod +x ~/.mymind/cc-hook.sh
# Wire into ~/.claude/settings.json hooks as: ~/.mymind/cc-hook.sh <EventName>
set -u
cfgdir="$HOME/.mymind"
[ -f "$cfgdir/config.env" ] && . "$cfgdir/config.env"
url="${MYMIND_URL:-}"
tok="${MYMIND_TOKEN:-}"
log="$cfgdir/cc-hook.log"
offdir="$cfgdir/transcript-offsets"
mid_file="$cfgdir/machine_id"
mkdir -p "$offdir" 2>/dev/null

event="${1:-unknown}"
[ -z "$url" ] || [ -z "$tok" ] && exit 0   # not configured — silent no-op

# stable machine id
if [ ! -s "$mid_file" ]; then
  (command -v uuidgen >/dev/null && uuidgen | tr 'A-Z' 'a-z' || python3 -c 'import uuid;print(uuid.uuid4())') > "$mid_file" 2>/dev/null
fi
mid="$( [ -s "$mid_file" ] && cat "$mid_file" || echo '' )"
host="$(hostname -s 2>/dev/null || hostname)"

# read hook payload from stdin
payload="$(mktemp -t mymind.payload.XXXXXX)"
body=""
trap 'rm -f "$payload" "$payload.body" "$body" 2>/dev/null' EXIT
cat > "$payload"
[ -s "$payload" ] || echo '{}' > "$payload"

# extract session_id, transcript_path, cwd
read -r sid tp cwd < <(MM_IN="$payload" python3 - <<'PY'
import json,os
try:
    d=json.load(open(os.environ["MM_IN"]))
    d=d if isinstance(d,dict) else {}
except Exception:
    d={}
print(d.get("session_id") or d.get("sessionId") or "",
      d.get("transcript_path") or "",
      d.get("cwd") or "")
PY
)

# git context (never fails)
gb="" ; gc="" ; gr="" ; proj=""
if [ -n "$cwd" ] && [ -d "$cwd" ]; then
  gb="$(git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  gc="$(git -C "$cwd" rev-parse HEAD 2>/dev/null)"
  gr="$(git -C "$cwd" config --get remote.origin.url 2>/dev/null)"
  proj="$(basename "$cwd")"
fi

# POST the event (background; short timeout; never blocks)
{
  MM_SID="$sid" MM_CWD="$cwd" MM_PROJ="$proj" MM_GB="$gb" MM_GC="$gc" MM_GR="$gr" \
  MM_MID="$mid" MM_HOST="$host" MM_EV="$event" python3 - > "$payload.body" <<'PY'
import json,os
print(json.dumps({
  "source":"claude_code",
  "external_id":os.environ["MM_SID"],
  "project":os.environ["MM_PROJ"] or None,
  "cwd":os.environ["MM_CWD"] or None,
  "git_branch":os.environ["MM_GB"] or None,
  "git_commit":os.environ["MM_GC"] or None,
  "git_remote":os.environ["MM_GR"] or None,
  "machine_id":os.environ["MM_MID"] or None,
  "hostname":os.environ["MM_HOST"] or None,
  "metadata":{"hostname":os.environ["MM_HOST"],"lastEvent":os.environ["MM_EV"]}
}))
PY
  if [ -n "$sid" ]; then
    curl -sS -m 5 -X POST \
      -H 'Content-Type: application/json' -H "Authorization: Bearer $tok" \
      --data-binary "@$payload.body" "$url/api/hooks/cc/$event" \
      >/dev/null 2>&1 || echo "$(date '+%F %T') event=$event POST failed" >> "$log"
  fi
  rm -f "$payload.body" 2>/dev/null
} &

# ship transcript delta on terminal events
body=""
case "$event" in
  Stop|SubagentStop|SessionEnd)
    if [ -n "$sid" ] && [ -n "$tp" ] && [ -f "$tp" ]; then
      off_file="$offdir/$sid.off"
      prev=0; [ -f "$off_file" ] && prev=$(cat "$off_file" 2>/dev/null || echo 0)
      size=$(wc -c < "$tp" | tr -d ' ')
      [ "$prev" -gt "$size" ] && prev=0
      if [ "$size" -gt "$prev" ]; then
        body="$(mktemp -t mymind.body.XXXXXX)"
        consumed=$(MM_SID="$sid" MM_TP="$tp" MM_PREV="$prev" MM_OUT="$body" python3 - <<'PY'
import json,os
sid=os.environ["MM_SID"]; path=os.environ["MM_TP"]; prev=int(os.environ["MM_PREV"]); out=os.environ["MM_OUT"]
MAX=4*1024*1024
with open(path,"rb") as f:
    f.seek(prev); raw=f.read(MAX)
nl=raw.rfind(b"\n"); consumed=(nl+1) if nl>=0 else 0
text=raw[:consumed].decode("utf-8","replace")
lines=[l for l in text.split("\n") if l.strip()]
json.dump({"source":"claude_code","external_id":sid,"lines":lines}, open(out,"w"))
print(consumed)
PY
)
        if [ "${consumed:-0}" -gt 0 ]; then
          if curl -sS -m 15 -X POST \
              -H 'Content-Type: application/json' -H "Authorization: Bearer $tok" \
              --data-binary "@$body" "$url/api/hooks/cc/transcript" >/dev/null 2>&1; then
            echo "$((prev + consumed))" > "$off_file"
          else
            echo "$(date '+%F %T') transcript POST failed sid=$sid" >> "$log"
          fi
        fi
      fi
    fi
    ;;
esac
wait 2>/dev/null || true
exit 0
