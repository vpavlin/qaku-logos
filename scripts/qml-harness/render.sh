#!/usr/bin/env bash
# Render module/Main.qml offscreen against a mock `logos` bridge and save a PNG.
#   render.sh [out.png]              - mock WITH callModuleAsync (new Basecamp bridge)
#   render.sh --sync-only [out.png]  - mock WITHOUT it (Basecamp 0.2.0: sync fallback path)
# Logs visible-question count, mutate de-dupe, error toast and the call sequence.
# Override store paths via QTDECL / QTBASE / LOGOS_DS env vars.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
QTDECL=${QTDECL:-/nix/store/4z51xyah9h8h3al1wclvgy6cb04vq0vl-qtdeclarative-6.10.2}
QTBASE=${QTBASE:-/nix/store/w4q31b93w262q2b75ri3jc7m3xd4i31h-qtbase-6.10.2}
LOGOS_DS=${LOGOS_DS:-/nix/store/xnzhjaj4bgncqf9clyylizlkcpip8gg6-logos-design-system-src/src/qml}
ARGS=()
[ "${1:-}" = "--sync-only" ] && { ARGS+=(--sync-only); shift; }
OUT="${1:-$HERE/render.png}"
export QT_QPA_PLATFORM=offscreen QT_QUICK_BACKEND=software QT_QUICK_CONTROLS_STYLE=Basic
export QT_LOGGING_RULES="qml.debug=true;js.debug=true" QT_FORCE_STDERR_LOGGING=1
export QML_IMPORT_PATH="$QTDECL/lib/qt-6/qml:$LOGOS_DS"
export QT_PLUGIN_PATH="$QTBASE/lib/qt-6/plugins:$QTDECL/lib/qt-6/plugins"
export LD_LIBRARY_PATH="$QTBASE/lib:$QTDECL/lib"
timeout 30 "$QTDECL/bin/qml" "$HERE/harness.qml" -- "${ARGS[@]}" "$OUT"
echo "rendered -> $OUT"
