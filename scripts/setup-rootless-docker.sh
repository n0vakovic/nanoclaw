#!/usr/bin/env bash
# User-local runtime setup. Never modifies system Docker, groups, ACLs or sysctls.
set -euo pipefail

if [[ $(id -u) == 0 ]]; then
  echo 'Run this script as the unprivileged NanoClaw user.' >&2
  exit 1
fi
for binary in docker dockerd newuidmap newgidmap curl tar sha256sum systemctl; do
  command -v "$binary" >/dev/null || { echo "Missing prerequisite: $binary" >&2; exit 1; }
done
if [[ $(uname -m) != x86_64 ]] || [[ $(dockerd --version) != *'29.7.2'* ]]; then
  echo 'This verified helper bundle requires Docker 29.7.2 on x86_64; review and update the pinned release first.' >&2
  exit 1
fi
for mapping in /etc/subuid /etc/subgid; do
  awk -F: -v username="$(id -un)" -v uid="$(id -u)" '($1 == username || $1 == uid) && $3 >= 65536 { found = 1 } END { exit !found }' "$mapping" || {
    echo "Missing subordinate IDs in $mapping; no system changes attempted." >&2
    exit 1
  }
done
systemctl --user show-environment >/dev/null

rootless_stage=$(mktemp -d)
trap 'rm -rf "$rootless_stage"' EXIT
rootless_bin="$HOME/.local/share/nanoclaw/rootless/bin"
rootless_unit="$HOME/.config/systemd/user/nanoclaw-docker.service"
curl --fail --location --proto '=https' --tlsv1.2 \
  https://download.docker.com/linux/static/stable/x86_64/docker-rootless-extras-29.7.2.tgz \
  --output "$rootless_stage/rootless.tgz"
echo "15a5cb81f2c5cf15ea21427f2e8241eac0deb2221175f993b5e76926e705ec6a  $rootless_stage/rootless.tgz" | sha256sum --check
tar xzf "$rootless_stage/rootless.tgz" -C "$rootless_stage"
install -d -m 700 "$rootless_bin"
install -m 755 "$rootless_stage/docker-rootless-extras/"{rootlesskit,dockerd-rootless.sh,dockerd-rootless-setuptool.sh} "$rootless_bin/"
mkdir -p "$(dirname "$rootless_unit")"
if [[ -f "$rootless_unit" ]]; then
  cp -p "$rootless_unit" "$rootless_unit.backup.$(date +%s)"
fi
cat > "$rootless_unit" <<UNIT
[Unit]
Description=NanoClaw private rootless Docker daemon
Documentation=https://docs.docker.com/engine/security/rootless/
After=network-online.target
Requires=dbus.socket

[Service]
Type=notify
NotifyAccess=all
Environment=PATH=$rootless_bin:/usr/local/bin:/usr/bin
Environment=DOCKERD_ROOTLESS_ROOTLESSKIT_NET=gvisor-tap-vsock
Environment=DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK=false
Environment=DOCKERD_ROOTLESS_ROOTLESSKIT_STATE_DIR=%t/nanoclaw-rootlesskit
ExecStart=%h/.local/share/nanoclaw/rootless/bin/dockerd-rootless.sh --host=unix://%t/nanoclaw-docker.sock --data-root=%h/.local/share/nanoclaw/docker --exec-root=%t/nanoclaw-docker --pidfile=%t/nanoclaw-docker.pid --host-gateway-ip=10.0.2.1
Restart=on-failure
RestartSec=3
TimeoutStartSec=60
TimeoutStopSec=30
LimitNOFILE=infinity
LimitNPROC=infinity
LimitCORE=infinity
TasksMax=infinity
Delegate=yes
KillMode=mixed

[Install]
WantedBy=default.target
UNIT
systemd-analyze --user verify "$rootless_unit"
systemctl --user daemon-reload
systemctl --user enable --now nanoclaw-docker.service
docker --host "unix:///run/user/$(id -u)/nanoclaw-docker.sock" info --format '{{json .SecurityOptions}} {{.DockerRootDir}} {{.CgroupDriver}}'
