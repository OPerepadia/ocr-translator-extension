#!/usr/bin/env bash
# Run scripts/quantize-models.py in its own virtualenv, creating it on first use.
# Passes every argument through:
#
#   scripts/quantize-models.sh --in-place
#
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
venv="$here/.venv"
requirements="$here/requirements-quantize.txt"
stamp="$venv/.requirements-sha"

if [ ! -x "$venv/bin/python" ]; then
  echo "Creating virtualenv in scripts/.venv ..."
  python3 -m venv "$venv"
fi

# Reinstall only when the pinned requirements change.
want="$(sha256sum "$requirements" | cut -d' ' -f1)"
if [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$want" ]; then
  echo "Installing quantization dependencies ..."
  "$venv/bin/python" -m pip install --quiet --upgrade pip
  "$venv/bin/python" -m pip install --quiet -r "$requirements"
  echo "$want" > "$stamp"
fi

exec "$venv/bin/python" "$here/quantize-models.py" "$@"
