#!/usr/bin/env node
/**
 * Build vehicle-host as gardend's local service `vehicle`, bundled: one ESM file with pi and every dependency
 * in it, instead of a 149 MB `pnpm deploy` tree.
 *
 *   node scripts/build-service.mjs <dest>                 # e.g. <gardend archive>/services/vehicle
 *   node scripts/build-service.mjs --test-bundle <file>    # the same bundling of the library + pi's faux
 *                                                         # provider, for running the tests against it
 *
 * <dest> must not exist (nothing is overwritten). What it holds:
 *
 *   service.json                 gardend's manifest: `node app/main.mjs`, Node 22.19 or later required
 *   LICENSE                      vehicle's licence (MIT)
 *   THIRD-PARTY-NOTICES.md       every bundled package: name, version, licence and its licence text
 *   BUILD.json                   the vehicle commit, pi's version and a sha256 of every file
 *   app/main.mjs                 vehicle-host, pi-sophia, pi 1.2.0 and their dependencies (esbuild); also an
 *                                isolated agent body's entry (`node app/main.mjs --vehicle-body`, pi's RPC mode)
 *   app/image-resize-worker.js   pi's image-resize worker (pi resizes in process when it cannot start it)
 *   app/package.json             `"type": "module"`, so the worker loads as ESM
 *   app/pi/                      pi-coding-agent's package.json (pi reads its name and version there) + licence
 *   app/node_modules/@silvia-odwyer/photon-node/   pi's image library: WebAssembly read from beside its own
 *                                code, so it stays a file (2 MB) and is loaded by pi on demand
 *
 * Bundling is safe for this service because vehicle-host gives pi everything it would otherwise look up on disk:
 * extensions arrive as factories (`noExtensions`, no jiti), MCP servers only from pi-sophia, no skills, themes,
 * prompt templates or context files, and pi-sophia replaces pi's coding prompt (which names pi's docs paths).
 * What is left relative to pi's package is listed above.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build, version as esbuildVersion } from "esbuild";

const TS = dirname(dirname(fileURLToPath(import.meta.url)));
const HOST = join(TS, "packages", "vehicle-host");
const NODE_FLOOR = "22.19";
const PHOTON = "@silvia-odwyer/photon-node";

const piDir = realpathSync(join(HOST, "node_modules", "@earendil-works", "pi-coding-agent"));
const piPackage = JSON.parse(readFileSync(join(piDir, "package.json"), "utf8"));
const photonDir = dirname(createRequire(join(piDir, "package.json")).resolve(`${PHOTON}/package.json`));

/** The options both bundles share: what is tested is bundled the way the service is. */
function bundleOptions(entry, outfile) {
	return {
		absWorkingDir: TS,
		entryPoints: [entry],
		outfile,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22.19",
		// The workspace packages from source (as the tests run them); pi from its published dist.
		conditions: ["sophia-source"],
		// Bundled CommonJS calls require(); in an ES module it must exist.
		banner: { js: 'import { createRequire as __vehicleCreateRequire } from "node:module"; const require = __vehicleCreateRequire(import.meta.url);' },
		external: [PHOTON],
		minify: true,
		legalComments: "eof",
		metafile: true,
		logLevel: "warning",
	};
}

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function filesUnder(dir) {
	const out = [];
	for (const name of readdirSync(dir).sort()) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...filesUnder(path));
		else out.push(path);
	}
	return out;
}

function git(...args) {
	return execFileSync("git", ["-C", TS, ...args], { encoding: "utf8" }).trim();
}

/** The package directory an input file belongs to, or null for the workspace's own files. */
function packageRootOf(input) {
	const marker = `node_modules${sep}`;
	const at = input.lastIndexOf(marker);
	if (at < 0) return null;
	const rest = input.slice(at + marker.length).split(sep);
	const name = rest[0]?.startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
	return join(input.slice(0, at + marker.length), name);
}

const LICENCE_FILE = /^(licen[cs]e|copying|notice)([.-][\w.-]*)?$/i;

/** A package's `License` section of its README (some packages keep their licence only there). */
function readmeLicence(root) {
	const readme = readdirSync(root).find((file) => /^readme(\.md|\.markdown)?$/i.test(file));
	if (!readme) return null;
	const lines = readFileSync(join(root, readme), "utf8").split("\n");
	const start = lines.findIndex((line, i) => /^#*\s*licen[cs]e\s*$/i.test(line.trim()) && (line.startsWith("#") || /^[-=]{3,}$/.test(lines[i + 1]?.trim() ?? "")));
	if (start < 0) return null;
	const body = [];
	for (const line of lines.slice(start + (lines[start].startsWith("#") ? 1 : 2))) {
		if (/^#/.test(line)) break;
		body.push(line);
	}
	const text = body.join("\n").trim();
	return text ? { file: `${readme} (its License section)`, text } : null;
}

/**
 * A package's licence texts: its licence files, the licences it bundles itself (`LICENSES/`), else one kept in
 * `ts/licenses/` (pi's packages ship none: pi's MIT licence from earendil-works/pi at v1.2.0 is `pi-LICENSE`;
 * `<scope>__<name>-LICENSE` for others), else the License section of its README.
 */
function licenceTexts(root, name) {
	const texts = [];
	for (const file of readdirSync(root).sort()) {
		if (LICENCE_FILE.test(file)) texts.push({ file, text: readFileSync(join(root, file), "utf8").trim() });
	}
	if (texts.length === 0) {
		const kept = join(TS, "licenses", name.startsWith("@earendil-works/pi-") ? "pi-LICENSE" : `${name.replace(/^@/, "").replace("/", "__")}-LICENSE`);
		if (existsSync(kept)) texts.push({ file: `ts/licenses/${basename(kept)}`, text: readFileSync(kept, "utf8").trim() });
	}
	const bundled = join(root, "LICENSES");
	if (existsSync(bundled)) {
		for (const file of readdirSync(bundled).sort()) {
			texts.push({ file: `LICENSES/${file}`, text: readFileSync(join(bundled, file), "utf8").trim() });
		}
	}
	if (texts.length) return texts;
	const fromReadme = readmeLicence(root);
	return fromReadme ? [fromReadme] : [];
}

function notices(metafiles, extraRoots) {
	const roots = new Set(extraRoots);
	for (const metafile of metafiles) {
		for (const input of Object.keys(metafile.inputs)) {
			const root = packageRootOf(join(TS, input));
			if (root) roots.add(realpathSync(root));
		}
	}
	const packages = [...roots]
		.map((root) => ({ root, manifest: JSON.parse(readFileSync(join(root, "package.json"), "utf8")) }))
		.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
	const missing = [];
	const lines = [
		"# Third-party notices",
		"",
		"`app/` of this service bundles the packages below with vehicle-host and pi-sophia (licensed under",
		"`LICENSE`). Each keeps its own licence; its text follows, as the package ships it.",
		"",
		"| Package | Version | Licence |",
		"|---|---|---|",
		...packages.map(({ manifest }) => `| ${manifest.name} | ${manifest.version} | ${manifest.license ?? "(none stated)"} |`),
		"",
	];
	for (const { root, manifest } of packages) {
		const texts = licenceTexts(root, manifest.name);
		lines.push(`## ${manifest.name} ${manifest.version}`, "", `Licence: ${manifest.license ?? "(none stated)"}`);
		const repository = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
		if (repository) lines.push(`Source: ${repository}`);
		lines.push("");
		if (texts.length === 0) {
			missing.push(`${manifest.name}@${manifest.version} (${manifest.license ?? "no licence field"})`);
			lines.push("The package ships no licence file; its licence is the one named above.", "");
		}
		for (const { file, text } of texts) lines.push(`### ${file}`, "", "````text", text, "````", "");
	}
	return { text: `${lines.join("\n")}\n`, count: packages.length, missing };
}

async function bundleTests(outfile) {
	const result = await build(bundleOptions(join(HOST, "service", "test-exports.mjs"), outfile));
	console.log(`build-service: test bundle ${outfile} (${(statSync(outfile).size / 1e6).toFixed(1)} MB, esbuild ${esbuildVersion})`);
	return result;
}

async function buildService(dest) {
	if (existsSync(dest)) throw new Error(`${dest} exists; move it aside first`);
	const app = join(dest, "app");
	mkdirSync(app, { recursive: true });

	const main = await build(bundleOptions(join(HOST, "service", "entry.mjs"), join(app, "main.mjs")));
	const worker = await build(bundleOptions(join(piDir, "dist", "utils", "image-resize-worker.js"), join(app, "image-resize-worker.js")));

	writeFileSync(join(app, "package.json"), `${JSON.stringify({ name: "@sophia-labs/vehicle-service", private: true, type: "module" }, null, "\t")}\n`);
	mkdirSync(join(app, "pi"));
	cpSync(join(piDir, "package.json"), join(app, "pi", "package.json"));
	cpSync(join(TS, "licenses", "pi-LICENSE"), join(app, "pi", "LICENSE"));
	const photonOut = join(app, "node_modules", ...PHOTON.split("/"));
	mkdirSync(photonOut, { recursive: true });
	for (const file of ["package.json", "LICENSE.md", "photon_rs.js", "photon_rs_bg.js", "photon_rs_bg.wasm"]) {
		cpSync(join(photonDir, file), join(photonOut, file));
	}

	const manifest = JSON.parse(readFileSync(join(HOST, "service", "service.json"), "utf8"));
	if (manifest.args?.[0] !== "app/main.mjs") throw new Error("service.json must run app/main.mjs");
	cpSync(join(HOST, "service", "service.json"), join(dest, "service.json"));
	cpSync(join(TS, "LICENSE"), join(dest, "LICENSE"));
	const { text, count, missing } = notices([main.metafile, worker.metafile], [realpathSync(photonDir)]);
	writeFileSync(join(dest, "THIRD-PARTY-NOTICES.md"), text);

	const commit = git("rev-parse", "HEAD");
	const dirty = git("status", "--porcelain", "--", ".") !== "";
	const files = Object.fromEntries(filesUnder(dest).map((path) => [relative(dest, path), sha256(path)]));
	const record = {
		schema: "sophia.vehicle-service-build.v1",
		vehicleCommit: commit,
		dirty,
		pi: piPackage.version,
		node: `>=${NODE_FLOOR}`,
		esbuild: esbuildVersion,
		builtWith: process.version,
		files,
	};
	writeFileSync(join(dest, "BUILD.json"), `${JSON.stringify(record, null, "\t")}\n`);

	const size = execFileSync("du", ["-sh", dest], { encoding: "utf8" }).split("\t")[0];
	console.log(
		`build-service: ${dest} ready (${size}; main.mjs ${(statSync(join(app, "main.mjs")).size / 1e6).toFixed(1)} MB; ${count} third-party packages; vehicle ${commit.slice(0, 7)}${dirty ? " + uncommitted changes" : ""}; pi ${piPackage.version}; esbuild ${esbuildVersion})`,
	);
	if (missing.length) console.log(`build-service: no licence file in ${missing.length} package(s), named by licence only: ${missing.join(", ")}`);
}

const args = process.argv.slice(2);
if (args[0] === "--test-bundle" && args[1]) {
	await bundleTests(args[1]);
} else if (args.length === 1 && !args[0].startsWith("-")) {
	await buildService(args[0]);
} else {
	console.error(`usage: ${basename(process.argv[1])} <dest> | --test-bundle <file>`);
	process.exit(2);
}
