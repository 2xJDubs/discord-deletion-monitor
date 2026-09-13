#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
require() {
  local pattern=$1 file=$2 message=$3
  grep -Eq -- "$pattern" "$ROOT/$file" || fail "$message"
}

require 'install -o root -g root -m 0600.*discord-deletion-monitor.env.example' deploy/install.sh \
  'installer must create the bot environment as root:root 0600'
require 'secure_secret_file.*ENV_FILE' deploy/install.sh \
  'installer must repair existing bot environment permissions'
require 'require_verified_online_backup' deploy/install.sh \
  'installer must require a verified backup before activation'
require 'node.*RELEASE_DIR/dist/backup\.js' deploy/install.sh \
  'backup gate must use the already-built and tested staged release CLI'
if grep -Eq 'node.*PREVIOUS_RELEASE/dist/backup\.js' "$ROOT/deploy/install.sh"; then
  fail 'backup gate must not use the previous release CLI'
fi
require 'write_release_metadata' deploy/install.sh \
  'installer must write release provenance metadata'
require '^StartLimitIntervalSec=' deploy/discord-deletion-monitor.service \
  'service must define a restart-rate interval'
require '^StartLimitBurst=' deploy/discord-deletion-monitor.service \
  'service must define a restart-rate burst'
require '/usr/bin/find .* -daystart -mtime \+14 ' deploy/discord-deletion-monitor-backup.service \
  'backup cleanup must encode exact approximately 15-day calendar semantics'
require 'node-version: \[22\]' .github/workflows/ci.yml \
  'CI must use the Node 22 toolchain required by pnpm 11'
require '"node": ">=22\.13"' package.json \
  'package engine must match the minimum Node version required by pnpm 11'
require '^[[:space:]]*- uses:[[:space:]]+actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1([[:space:]]+#.*)?$' .github/workflows/ci.yml \
  'checkout must use the approved immutable Node 24-based release pin'
require '^[[:space:]]*- uses:[[:space:]]+actions/setup-node@820762786026740c76f36085b0efc47a31fe5020([[:space:]]+#.*)?$' .github/workflows/ci.yml \
  'setup-node must use the approved immutable Node 24-based release pin'
require '^[[:space:]]*- uses:[[:space:]]+pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86([[:space:]]+#.*)?$' .github/workflows/ci.yml \
  'pnpm setup must use the approved immutable Node 24-based release pin'
require '^[[:space:]]*sudo bash deploy/install-lib\.test\.sh[[:space:]]*$' .github/workflows/ci.yml \
  'CI must run root-ownership deployment tests with deployment privileges'
require 'if: matrix.node-version == 22' .github/workflows/ci.yml \
  'expensive deployment validation must run once'
require 'dist.*test' .github/workflows/ci.yml \
  'CI must assert that dist excludes tests'
require '24 GB|24 GiB' deploy/README.md \
  'deployment sizing must account for attachment and backup capacity'
require 'Debian 13 day-zero|day-zero Debian 13' deploy/README.md \
  'deployment guide must include reproducible Debian 13 bootstrap'
require 'client_ready' deploy/README.md \
  'restore runbook must include client_ready verification'
require 'WAL|wal' deploy/README.md \
  'restore runbook must preserve WAL state'
require 'lockfile_sha256|lockfile hash' deploy/README.md \
  'rollback documentation must cover lockfile provenance'
require 'find .* -daystart -mtime \+14' deploy/README.md \
  'operator guide must document exact backup expiration command'
require 'PRAGMA foreign_key_check' deploy/README.md \
  'restore runbook must require a clean foreign_key_check before activation'
require 'PRAGMA quick_check' deploy/README.md \
  'restore runbook must require quick_check before activation'

mapfile -t DOCUMENTATION_INPUTS < <(
  sed -n 's/.*read("\.\.\/\([^"]*\)").*/\1/p' "$ROOT/src/documentation.test.ts" | sort -u
)
mapfile -t STAGED_FILES < <(
  sed -n '/^STAGED_FILES=(/,/^)/p' "$ROOT/deploy/install.sh" |
    sed -n 's/^[[:space:]]*\([^()[:space:]]\+\)[[:space:]]*$/\1/p'
)
for input in "${DOCUMENTATION_INPUTS[@]}"; do
  printf '%s\n' "${STAGED_FILES[@]}" | grep -Fqx -- "$input" ||
    fail "installer stage omits documentation test input: $input"
done

printf '%s\n' 'operational static tests passed'