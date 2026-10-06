#!/usr/bin/env bash
# Starts/stops an isolated, throw-away PostgreSQL cluster for local development WITHOUT Docker.
# It never touches a system/Homebrew Postgres service: data lives in .local/pgdata (gitignored)
# and it listens only on 127.0.0.1:${LEADGEN_PGPORT:-54349}.
#
#   npm run db:local            # start (creates the cluster on first run)
#   npm run db:local -- stop
#   npm run db:local -- status
#   npm run db:local -- reset   # DESTROYS the local cluster and its data
#
# Requires the Postgres server binaries (initdb, pg_ctl, psql) on PATH, e.g. `brew install postgresql@17`.
set -euo pipefail

# macOS Postgres aborts at startup ("postmaster became multithreaded") when no valid locale is set,
# which is the case in many non-interactive shells. Pin one.
export LC_ALL="${LC_ALL:-en_US.UTF-8}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${LEADGEN_PGDATA:-$ROOT/.local/pgdata}"
PORT="${LEADGEN_PGPORT:-54349}"
LOG_FILE="$DATA_DIR/server.log"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "error: '$1' not found on PATH. Install PostgreSQL 16+ (e.g. 'brew install postgresql@17') or use docker compose." >&2
    exit 1
  }
}

is_running() {
  pg_ctl -D "$DATA_DIR" status >/dev/null 2>&1
}

create_db_if_missing() {
  local db="$1"
  if ! psql -h 127.0.0.1 -p "$PORT" -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$db'" | grep -q 1; then
    psql -h 127.0.0.1 -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $db" >/dev/null
    echo "created database $db"
  fi
}

cmd="${1:-start}"
case "$cmd" in
  start)
    need initdb; need pg_ctl; need psql
    if [ ! -d "$DATA_DIR" ]; then
      echo "initialising cluster in $DATA_DIR"
      mkdir -p "$DATA_DIR"
      initdb -D "$DATA_DIR" -U postgres --auth=trust -E UTF8 --locale=en_US.UTF-8 >/dev/null
    fi
    if is_running; then
      echo "already running on port $PORT"
    else
      # Empty unix_socket_directories => TCP only, nothing written outside the data dir.
      pg_ctl -D "$DATA_DIR" -l "$LOG_FILE" -w \
        -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories= -c fsync=on -c max_connections=200" start >/dev/null
      echo "started on 127.0.0.1:$PORT"
    fi
    create_db_if_missing electrical_dev
    echo "DATABASE_URL=postgres://postgres@127.0.0.1:$PORT/electrical_dev"
    echo "TEST_DATABASE_URL=postgres://postgres@127.0.0.1:$PORT/postgres"
    ;;
  stop)
    need pg_ctl
    if [ -d "$DATA_DIR" ] && is_running; then
      pg_ctl -D "$DATA_DIR" -m fast -w stop >/dev/null
      echo "stopped"
    else
      echo "not running"
    fi
    ;;
  status)
    need pg_ctl
    if [ -d "$DATA_DIR" ] && is_running; then echo "running on 127.0.0.1:$PORT"; else echo "stopped"; fi
    ;;
  reset)
    need pg_ctl
    if [ -d "$DATA_DIR" ] && is_running; then pg_ctl -D "$DATA_DIR" -m immediate -w stop >/dev/null; fi
    rm -rf "$DATA_DIR"
    echo "local cluster removed"
    ;;
  *)
    echo "usage: $0 [start|stop|status|reset]" >&2
    exit 2
    ;;
esac
