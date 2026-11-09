#!/usr/bin/env bash
# Gives each Paseo worktree its own block of 10 ports, the way Conductor's $CONDUCTOR_PORT did:
# ui on the base, landing +1, Metro +2, emails +3, admin +4. `pnpm verify:ui` and `pnpm dev:mobile`
# read the base from CONDUCTOR_PORT, which the setup of paseo.json writes into the worktree's
# .claude/settings.local.json for the agents.
#
#   workspace-port.sh            the base port of this worktree, claiming a free block on the first call
#   workspace-port.sh <service>  the port of one service (Paseo calls it as worktree.servicePorts.portScript)
set -euo pipefail

worktree="${PASEO_WORKTREE_PATH:-$(git rev-parse --show-toplevel)}"
port_file="$worktree/.context/port"
claims_dir="$HOME/.paseo/rerun-workspace-ports"

if [ ! -s "$port_file" ]; then
  mkdir -p "$claims_dir" "$(dirname "$port_file")"
  base=""
  for candidate in $(seq 3100 10 3990); do
    claim="$claims_dir/$candidate"
    if [ -f "$claim" ]; then
      owner=$(cat "$claim")
      # A block stays taken while the worktree that claimed it still exists.
      if [ "$owner" != "$worktree" ] && [ -d "$owner" ]; then continue; fi
    fi
    if lsof -nP -iTCP:"$candidate-$((candidate + 9))" -sTCP:LISTEN >/dev/null 2>&1; then continue; fi
    echo "$worktree" >"$claim"
    base=$candidate
    break
  done
  if [ -z "$base" ]; then
    echo "workspace-port: no free block of 10 ports between 3100 and 3999" >&2
    exit 1
  fi
  echo "$base" >"$port_file"
fi
base=$(cat "$port_file")

case "${1:-}" in
  "" | ui | everything) offset=0 ;;
  landing) offset=1 ;;
  emails) offset=3 ;;
  admin) offset=4 ;;
  *)
    echo "workspace-port: no port planned for the service '$1', add it to scripts/paseo/workspace-port.sh" >&2
    exit 1
    ;;
esac
echo $((base + offset))
