#!/usr/bin/env bash
# Cutover (cycle 86 final wave M1): copy the uploads from LXC 114 to the Mac mini, then prove the copy.
#
# Run it as root ON THE PROXMOX HOST — the only machine that reaches both: LXC 114 via `pct exec`, the
# mini via the CD key /root/.ssh/mymind_macmini (LXC 114 has no key to the mini, and the mini's rsync is
# Apple's openrsync, so this is tar over ssh, as CD does). Run it after the LXC units are stopped, so no
# upload lands mid-copy. Idempotent: re-running overwrites with the same files.
#
# Verifies: the same file list (relative paths) and the same total byte count on both sides.
#
# Usage: bash copy-uploads.sh
# Overrides (tests): LXC_EXEC (default "pct exec 114 --"), MINI_SSH (default the CD ssh to
#   bridget@192.168.2.35, run as `$MINI_SSH '<remote command>'`), SRC_DIR, DST_DIR (the mini's, ~-relative ok).
set -euo pipefail
LXC_EXEC="${LXC_EXEC-pct exec 114 --}"
MINI_SSH="${MINI_SSH:-ssh -i /root/.ssh/mymind_macmini -o BatchMode=yes -o StrictHostKeyChecking=yes bridget@192.168.2.35}"
SRC_DIR="${SRC_DIR:-/opt/mymind/.data/uploads}"
DST_DIR="${DST_DIR:-~/mymind/data/uploads}"

# Portable on GNU and BSD: the sorted relative file list, then the total bytes (all content through wc).
MANIFEST='find . -type f | LC_ALL=C sort; echo "bytes $(find . -type f -exec cat {} + | wc -c | tr -d " ")"'

echo "[uploads] copying $SRC_DIR (LXC 114) -> $DST_DIR (mini)"
set -o pipefail
$LXC_EXEC tar -C "$SRC_DIR" -cf - . | $MINI_SSH "mkdir -p $DST_DIR && tar -x -C $DST_DIR -f -"

src="$($LXC_EXEC bash -c "cd '$SRC_DIR' && $MANIFEST")"
dst="$($MINI_SSH "cd $DST_DIR && $MANIFEST")"
files=$(printf '%s\n' "$src" | grep -vc '^bytes ' || true)
if [ "$src" = "$dst" ]; then
  echo "[uploads] ok: $files files, $(printf '%s\n' "$src" | sed -n 's/^bytes //p') bytes on both sides"
  exit 0
fi
echo "[uploads] MISMATCH between LXC 114 and the mini:"
diff <(printf '%s\n' "$src") <(printf '%s\n' "$dst") | head -40 || true
exit 1
