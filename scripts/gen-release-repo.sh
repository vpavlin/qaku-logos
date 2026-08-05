#!/usr/bin/env bash
# Generate a Logos Basecamp package repo (logos-repo.json + index.json) whose
# package URLs point at this repo's GitHub *release* assets, so Basecamp installs
# QAKU straight from the tagged GitHub release (not a laptop/LAN host).
#
# Add this URL in Basecamp -> Settings -> Package Repositories:
#     https://github.com/vpavlin/qaku-logos/releases/download/<tag>/logos-repo.json
#
# Two Basecamp facts (paid for by KYM/Perun, kept here):
#  1. The repo URL MUST be https:// (logos-package-downloader hard-rejects other
#     schemes) - GitHub release URLs are https, so this Just Works, no LAN cert.
#  2. The URL you paste is logos-repo.json (the catalog card carrying indexUrl ->
#     index.json), NOT index.json directly.
#
# Usage: scripts/gen-release-repo.sh <tag>   (default: v0.1.0)
set -euo pipefail
TAG="${1:-v0.1.0}"
REPO="${REPO:-vpavlin/qaku-logos}"
BASE="https://github.com/${REPO}/releases/download/${TAG}"
ROOT="$(cd "$(dirname "$0")/.."; pwd)"
DIST="${ROOT}/dist"
cd "${DIST}"

cat > logos-repo.json <<JSON
{
  "schemaVersion": 1,
  "name": "qaku",
  "displayName": "QAKU - Q&A",
  "description": "Local-first, multi-writer Q&A for Logos Basecamp, served from GitHub releases.",
  "homepage": "https://github.com/${REPO}",
  "indexUrl": "${BASE}/index.json",
  "trustedSigners": []
}
JSON

python3 - "$BASE" <<'PY' > index.json
import glob, hashlib, json, subprocess, sys, datetime
base = sys.argv[1]
packages = []
for lgx in sorted(glob.glob("*.lgx")):
    try:
        manifest = json.loads(subprocess.check_output(["tar", "xzOf", lgx, "manifest.json"]))
    except Exception as e:
        print(f"skip {lgx}: {e}", file=sys.stderr); continue
    data = open(lgx, "rb").read()
    name, ver = manifest["name"], manifest.get("version", "0.0.0")
    packages.append({
        "name": name,
        "versions": [{
            "releasedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "publisherRef": f"{name}-v{ver}",
            "url": f"{base}/{lgx}",
            "size": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "rootHash": manifest["hashes"]["root"],
            "manifest": manifest,
        }],
    })
json.dump({
    "schemaVersion": 2,
    "repositoryName": "qaku",
    "generatedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "packages": packages,
}, sys.stdout, indent=2)
print()
PY

echo "Basecamp repo generated: ${BASE}/logos-repo.json  ($(ls *.lgx 2>/dev/null | wc -l) package(s))" >&2
