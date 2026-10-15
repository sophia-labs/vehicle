#!/usr/bin/env bash
# Package vehicle-host as a gardend local service: <dest>/service.json and <dest>/app. gardend finds it as
# services/vehicle/service.json beside its binary (or under GARDEN_SERVICES_DIR), checks for Node 22.19 or later
# on its PATH, starts `node app/main.mjs` in <dest> and mounts it at /services/vehicle.
#
#   ts/scripts/package-service.sh <dest>            # bundled (esbuild): about 10 MB, see build-service.mjs
#   ts/scripts/package-service.sh --deploy <dest>   # the fallback: `pnpm deploy` of the built packages, 149 MB,
#                                                   # runs app/dist/main.js; for when a bundle misbehaves
#
# <dest> must not exist yet (nothing is overwritten). Both type-check first; the bundled build is what gardend
# archives carry (`node scripts/test-bundle.mjs <dest>` runs vehicle-host's tests against it).
set -euo pipefail
mode=bundle
if [[ ${1:-} == --deploy ]]; then mode=deploy; shift; fi
dest=${1:?usage: package-service.sh [--deploy] <dest>}
[[ -e $dest ]] && { echo "package-service: $dest exists; move it aside first" >&2; exit 2; }
here=$(cd "$(dirname "$0")/.." && pwd)
cd "$here"
pnpm install --frozen-lockfile
pnpm -r run typecheck
if [[ $mode == bundle ]]; then
	node scripts/build-service.mjs "$dest"
	exit 0
fi
pnpm -r run build
mkdir -p "$dest"
pnpm --filter @sophia-labs/vehicle-host deploy --prod --legacy "$dest/app"
node -e '
	const fs = require("node:fs");
	const [from, to] = process.argv.slice(1);
	const manifest = JSON.parse(fs.readFileSync(from, "utf8"));
	manifest.args = ["app/dist/main.js"];
	fs.writeFileSync(to, JSON.stringify(manifest, null, "\t") + "\n");
' packages/vehicle-host/service/service.json "$dest/service.json"
cp LICENSE "$dest/LICENSE"
echo "package-service: $dest ready ($(du -sh "$dest" | cut -f1)); service.json runs node app/dist/main.js"
