#!/usr/bin/env bash
# Sandbox network + egress firewall (cycle 82, spec §2 D5 / §9). Idempotent; run as root on the
# Docker host (LXC 114). Mirrors packages/core/src/lib/sandbox/network.ts EXACTLY —
# packages/core/src/lib/sandbox/network.test.ts fails on any drift, and the worker refuses to start
# a sandbox when the live rules differ from the plan (fail closed).
#
#   install-network.sh install   — network + rules + workspaces dir + systemd oneshot (provisioning)
#   install-network.sh apply     — network + rules only (what the oneshot runs at every boot)
#
# Rules key on the bridge NAME (br-mymind-sbx), so they hold no matter when Docker (re)creates the
# network. No unfiltered window, ever (review M2): our two chains are replaced in ONE
# `iptables-restore --noflush` transaction (the kernel swaps the whole table atomically, legacy and
# nft alike), and a jump is only ever ADDED before a stale copy is deleted — never deleted first.
# Nobody else's rules are touched. Refuses to run when dockerd's own chains are not visible to this
# iptables (backend mismatch / docker iptables:false): rules there would never be reached (I3).
set -euo pipefail

NETWORK=mymind-sandbox
BRIDGE=br-mymind-sbx
SUBNET=172.31.82.0/24
FWD=MYMIND-SANDBOX-FWD
IN=MYMIND-SANDBOX-IN
# Keep in this order (network.ts BLOCKED_DESTINATIONS).
BLOCKED="0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4"
WORKSPACES_DIR="${SANDBOX_WORKSPACES_DIR:-/opt/mymind/.workspaces}"
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"

log() { echo "[sandbox-net] $*"; }

ensure_network() {
  if docker network inspect "$NETWORK" >/dev/null 2>&1; then
    local br icc
    br="$(docker network inspect "$NETWORK" --format '{{index .Options "com.docker.network.bridge.name"}}' || true)"
    icc="$(docker network inspect "$NETWORK" --format '{{index .Options "com.docker.network.bridge.enable_icc"}}' || true)"
    if [ "$br" = "$BRIDGE" ] && [ "$icc" = "false" ]; then return 0; fi
    # Wrong shape (made by hand?) — the firewall would not apply to it. Recreate when unused.
    log "network $NETWORK has bridge='$br' icc='$icc' — recreating"
    docker network rm "$NETWORK" >/dev/null
  fi
  log "creating network $NETWORK ($SUBNET on $BRIDGE)"
  docker network create --driver bridge --subnet "$SUBNET" \
    --opt "com.docker.network.bridge.name=$BRIDGE" \
    --opt com.docker.network.bridge.enable_icc=false \
    --ipv6=false \
    --label mymind.sandbox=network "$NETWORK" >/dev/null
}

die() { log "ERROR: $*"; exit 1; }

check_docker_chains() {
  iptables -S DOCKER >/dev/null 2>&1 || die "dockerd's DOCKER chain is not visible to $(command -v iptables) — iptables backend mismatch (legacy vs nft) or docker runs with iptables disabled"
  iptables -S DOCKER-USER >/dev/null 2>&1 || die "no DOCKER-USER chain — start dockerd first (it creates it)"
  iptables -C FORWARD -j DOCKER-USER 2>/dev/null || die "FORWARD does not jump to DOCKER-USER — rules there would never be reached"
}

ensure_jump() { # parent chain, target chain — present exactly once, as the FIRST rule of the parent
  local parent="$1" target="$2" want first nums
  want="-A $parent -i $BRIDGE -j $target"
  first="$(iptables -S "$parent" | sed -n 2p || true)"
  if [ "$first" != "$want" ]; then iptables -I "$parent" 1 -i "$BRIDGE" -j "$target"; fi
  # Now rule 1 is the jump; delete any later copies, highest number first (numbers stay valid).
  nums="$(iptables -S "$parent" | tail -n +2 | grep -nxF -- "$want" | cut -d: -f1 | tail -n +2 | sort -rn || true)"
  for n in $nums; do iptables -D "$parent" "$n"; done
}

apply_rules() {
  check_docker_chains
  {
    echo "*filter"
    echo ":$FWD - [0:0]"
    echo ":$IN - [0:0]"
    for d in $BLOCKED; do
      echo "-A $FWD -d $d -j REJECT --reject-with icmp-net-prohibited"
    done
    echo "-A $FWD -j RETURN"
    echo "-A $IN -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT"
    echo "-A $IN -j REJECT --reject-with icmp-host-prohibited"
    echo "COMMIT"
  } | iptables-restore --noflush
  ensure_jump DOCKER-USER "$FWD"
  ensure_jump INPUT "$IN"
  log "rules applied ($FWD, $IN)"
}

install_unit() {
  cat > /etc/systemd/system/mymind-sandbox-net.service <<EOF
[Unit]
Description=MyMind sandbox network + egress firewall (cycle 82)
After=docker.service
Requires=docker.service
PartOf=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash $SELF apply

[Install]
WantedBy=multi-user.target docker.service
EOF
  systemctl daemon-reload
  systemctl enable mymind-sandbox-net.service >/dev/null 2>&1 || true
  log "systemd oneshot mymind-sandbox-net installed + enabled"
}

case "${1:-install}" in
  apply)
    ensure_network
    apply_rules
    ;;
  install)
    command -v iptables-restore >/dev/null 2>&1 || { log "iptables missing — installing"; apt-get update -qq && apt-get install -y iptables >/dev/null; }
    ensure_network
    apply_rules
    mkdir -p "$WORKSPACES_DIR"
    chmod 0711 "$WORKSPACES_DIR"
    install_unit
    ;;
  *)
    echo "usage: $0 [install|apply]" >&2; exit 2 ;;
esac
