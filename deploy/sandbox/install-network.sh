#!/usr/bin/env bash
# Sandbox network + egress firewall (cycle 82, spec §2 D5 / §9). Idempotent; run as root on the
# Docker host (LXC 114). Mirrors packages/core/src/lib/sandbox/network.ts EXACTLY —
# test/sandbox-network.test.ts fails on any drift, and the worker refuses to start a sandbox when
# the live rules differ from the plan (fail closed).
#
#   install-network.sh install   — network + rules + workspaces dir + systemd oneshot (provisioning)
#   install-network.sh apply     — network + rules only (what the oneshot runs at every boot)
#
# Rules key on the bridge NAME (br-mymind-sbx), so they hold no matter when Docker (re)creates the
# network. Our own chains are flushed + refilled; the parent chains (DOCKER-USER, INPUT) only ever
# get the single jump inserted at position 1 when it is missing — nobody else's rules are touched.
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
    --label mymind.sandbox=network "$NETWORK" >/dev/null
}

ensure_chain() { iptables -N "$1" 2>/dev/null || true; iptables -F "$1"; }

ensure_jump() { # parent chain, target chain — first rule of the parent, exactly once
  local parent="$1" target="$2"
  while iptables -C "$parent" -i "$BRIDGE" -j "$target" 2>/dev/null; do
    iptables -D "$parent" -i "$BRIDGE" -j "$target"
  done
  iptables -I "$parent" 1 -i "$BRIDGE" -j "$target"
}

apply_rules() {
  # DOCKER-USER exists once dockerd has started; create it if we run first (dockerd keeps it).
  iptables -N DOCKER-USER 2>/dev/null || true
  ensure_chain "$FWD"
  for d in $BLOCKED; do
    iptables -A "$FWD" -d "$d" -j REJECT --reject-with icmp-net-prohibited
  done
  iptables -A "$FWD" -j RETURN
  ensure_chain "$IN"
  iptables -A "$IN" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  iptables -A "$IN" -j REJECT --reject-with icmp-host-prohibited
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
    command -v iptables >/dev/null 2>&1 || { log "iptables missing — installing"; apt-get install -y iptables >/dev/null; }
    ensure_network
    apply_rules
    mkdir -p "$WORKSPACES_DIR"
    chmod 0711 "$WORKSPACES_DIR"
    install_unit
    ;;
  *)
    echo "usage: $0 [install|apply]" >&2; exit 2 ;;
esac
