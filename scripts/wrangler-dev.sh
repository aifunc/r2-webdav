#!/usr/bin/env sh
set -eu

PROJECT_ROOT=$(
	CDPATH= cd -- "$(dirname -- "$0")/.." && pwd
)
PROJECT_XDG_CONFIG_HOME="$PROJECT_ROOT/.tmp/xdg"

mkdir -p "$PROJECT_XDG_CONFIG_HOME"

export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$PROJECT_XDG_CONFIG_HOME}"

exec "$PROJECT_ROOT/node_modules/.bin/wrangler" dev --ip "${WRANGLER_DEV_IP:-0.0.0.0}" "$@"
