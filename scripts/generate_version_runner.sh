#!/bin/bash
set -euo pipefail

node_bin="$1"
shift

"$node_bin" --disable-warning=ExperimentalWarning --experimental-transform-types scripts/generate_version.mjs "$@"
