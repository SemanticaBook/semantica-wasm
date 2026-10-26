#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WASM_DIR="$ROOT"
USER_CACHE_ROOT="${SEMANTICA_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/semantica}"
UPSTREAM_DIR="$USER_CACHE_ROOT/layaForWeb"
BUILD_DIR="${SEMANTICA_MODEL_BUILD_DIR:-$USER_CACHE_ROOT/build-multilingual}"
if [[ -n "${WEB_MODEL_DIR:-}" ]]; then
  MODEL_DIR="$WEB_MODEL_DIR"
elif [[ -d "$ROOT/apps/web" ]]; then
  MODEL_DIR="$ROOT/apps/web/public/models/laya-multilingual"
else
  MODEL_DIR="$ROOT/models/laya-multilingual"
fi
if [[ -z "${PYTHON_BIN:-}" ]]; then
  if command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="$(command -v python3)"
  else
    PYTHON_BIN="python"
  fi
fi

if ! command -v git >/dev/null 2>&1; then
  echo "Error: git is required to fetch the Laya export tooling." >&2
  exit 1
fi
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "Error: Python was not found at '$PYTHON_BIN'. Set PYTHON_BIN to a Python 3.11+ executable." >&2
  exit 1
fi
PYTHON_VERSION="$($PYTHON_BIN -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
if ! "$PYTHON_BIN" -c 'import sys; raise SystemExit(sys.version_info < (3, 11))'; then
  echo "Error: Python 3.11 or later is required; found $PYTHON_VERSION." >&2
  exit 1
fi

# Keep export dependencies out of the system Python and outside npm's package directory.
if ! "$PYTHON_BIN" -c 'import sys; raise SystemExit(sys.prefix != sys.base_prefix)' >/dev/null 2>&1; then
  BUILDER_VENV="$USER_CACHE_ROOT/model-builder-venv"
  if [[ ! -x "$BUILDER_VENV/bin/python" ]]; then
    mkdir -p "$USER_CACHE_ROOT"
    "$PYTHON_BIN" -m venv "$BUILDER_VENV"
  fi
  PYTHON_BIN="$BUILDER_VENV/bin/python"
fi

PYTHON_VERSION="$($PYTHON_BIN -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
echo "Preparing the Laya multilingual model (Python $PYTHON_VERSION)."
echo "The original checkpoint is about 644 MB; ONNX export needs additional disk space and memory."
echo "Output directory: $MODEL_DIR"

if [[ ! -d "$UPSTREAM_DIR/.git" ]]; then
  mkdir -p "$(dirname "$UPSTREAM_DIR")"
  git clone --depth 1 https://github.com/vishalmysore/layaForWeb.git "$UPSTREAM_DIR"
fi

"$PYTHON_BIN" -m pip install "onnx==1.23.0" "onnxscript==0.7.2" "onnxruntime==1.25.0" "huggingface_hub>=1.32.0"
"$PYTHON_BIN" "$WASM_DIR/scripts/prepare_multilingual.py" --out "$BUILD_DIR"

for stage in export q8e8 package; do
  "$PYTHON_BIN" "$UPSTREAM_DIR/scripts/build_model.py" \
    --stage "$stage" \
    --out "$BUILD_DIR" \
    --variants q8e8 \
    --repo convaiinnovations/laya/multilingual
done

"$PYTHON_BIN" "$UPSTREAM_DIR/scripts/verify_model.py" --out "$BUILD_DIR"
"$PYTHON_BIN" "$WASM_DIR/scripts/generate-sequence-fixtures.py" \
  --model "$BUILD_DIR/en" \
  --out "$WASM_DIR/tests/sequence-fixtures.json"
node --experimental-strip-types "$WASM_DIR/tests/sequence-parity.mjs" \
  "$BUILD_DIR/model" "$WASM_DIR/tests/sequence-fixtures.json"
"$PYTHON_BIN" "$WASM_DIR/scripts/patch_model_notices.py" "$BUILD_DIR/model"
"$PYTHON_BIN" "$WASM_DIR/scripts/add_model_part_hashes.py" "$BUILD_DIR/model"

rm -rf "$MODEL_DIR"
mkdir -p "$(dirname "$MODEL_DIR")"
cp -a "$BUILD_DIR/model" "$MODEL_DIR"
printf '\nBrowser model ready: %s\n' "$MODEL_DIR"
printf 'The first browser load downloads several hundred MB; later loads use Cache Storage.\n'
