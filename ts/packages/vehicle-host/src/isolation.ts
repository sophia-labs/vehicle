/**
 * Isolation is a setting, not an architecture (principle 7 in the README). An `agent` body runs pi's built-in tools
 * (`read`, `write`, `edit`, `bash`), so it runs as a child process inside a box; a `chat` body only touches the
 * graph and stays in the host's process.
 *
 *   VEHICLE_ISOLATION=bwrap      Linux and WSL2: bubblewrap. A read-only system (/usr, /etc and the library dirs),
 *                                the session's workspace and pi's own folder for the session the only writable
 *                                paths, a private tmpfs /tmp, no home, `--unshare-all --share-net` (pi calls the
 *                                model itself), `--die-with-parent`, a cleared environment.
 *   VEHICLE_ISOLATION=seatbelt   macOS: `sandbox-exec` with a generated, deny-by-default profile. Writes only in
 *                                the workspace, pi's folder and a private temporary folder; no reads in the home
 *                                folder or the data dir except what node and the body need; network allowed;
 *                                no Launch Services, Apple Events or launchd (the ways out of a seatbelt).
 *   VEHICLE_ISOLATION=microvm    a microVM where KVM exists (the Gondolin/Arrakis pattern): not implemented yet;
 *                                agent sessions are refused with that reason.
 *   VEHICLE_ISOLATION=none       no box. Agent sessions are refused unless the operator also sets
 *                                VEHICLE_AGENT_UNISOLATED=1 (an explicit choice to run code unisolated).
 *
 * The default follows the platform: bwrap on Linux, seatbelt on macOS, none elsewhere (Windows runs Sophia in WSL2,
 * which is Linux). The chosen tier is probed once (a real box running `true`), and a tier that cannot make a box
 * refuses agent sessions with the probe's own reason.
 */

import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, sep } from "node:path";

export const ISOLATION_TIERS = ["none", "bwrap", "seatbelt", "microvm"] as const;
export type IsolationTier = (typeof ISOLATION_TIERS)[number];
/** The tiers that can make a box today. */
export type BoxTier = Exclude<IsolationTier, "microvm">;

export interface IsolationSetting {
	readonly tier: IsolationTier;
	/** `VEHICLE_ISOLATION` named it, or the platform's default. */
	readonly source: "VEHICLE_ISOLATION" | "default";
	/** `VEHICLE_AGENT_UNISOLATED=1`: the operator lets agent bodies run with tier `none`. */
	readonly allowUnisolatedAgent: boolean;
}

export function defaultTier(platform: NodeJS.Platform = process.platform): IsolationTier {
	if (platform === "linux") return "bwrap";
	if (platform === "darwin") return "seatbelt";
	return "none";
}

export function isIsolationTier(value: unknown): value is IsolationTier {
	return typeof value === "string" && (ISOLATION_TIERS as readonly string[]).includes(value);
}

/** The setting from the host's environment. An unknown tier is an error (the host refuses to start). */
export function isolationSetting(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): IsolationSetting {
	const named = env.VEHICLE_ISOLATION?.trim();
	if (named && !isIsolationTier(named)) {
		throw new Error(`VEHICLE_ISOLATION must be one of ${ISOLATION_TIERS.join(", ")} (it is "${named}")`);
	}
	return {
		tier: named ? (named as IsolationTier) : defaultTier(platform),
		source: named ? "VEHICLE_ISOLATION" : "default",
		allowUnisolatedAgent: env.VEHICLE_AGENT_UNISOLATED?.trim() === "1",
	};
}

/** Why this setting cannot host an agent body, before any probe (`undefined`: it may). */
export function settingRefusal(setting: IsolationSetting, platform: NodeJS.Platform = process.platform): string | undefined {
	switch (setting.tier) {
		case "microvm":
			return "VEHICLE_ISOLATION=microvm needs KVM and is not implemented yet: use bwrap (Linux, WSL2) or seatbelt (macOS)";
		case "none":
			return setting.allowUnisolatedAgent
				? undefined
				: "agent sessions run code, so they need an isolated body, and this host's VEHICLE_ISOLATION is none: set bwrap (Linux, WSL2) or seatbelt (macOS), or VEHICLE_AGENT_UNISOLATED=1 to run agents unisolated on purpose";
		case "bwrap":
			return platform === "linux" ? undefined : "VEHICLE_ISOLATION=bwrap needs Linux (or WSL2)";
		case "seatbelt":
			return platform === "darwin" ? undefined : "VEHICLE_ISOLATION=seatbelt needs macOS";
	}
}

/** What a box is made of. Every path is absolute; the box sees each at the same path as the host. */
export interface BoxSpec {
	readonly tier: BoxTier;
	/** The node binary (its real path). */
	readonly node: string;
	readonly nodeArgs: readonly string[];
	/** The body's entry file and its arguments. */
	readonly entry: string;
	readonly entryArgs: readonly string[];
	/** Read-only inside the box: the body's code (the service's `app/`, or the source workspace in development). */
	readonly readable: readonly string[];
	/** The session's workspace: the body's current directory, writable. */
	readonly workdir: string;
	/** pi's folder for this session (its session file), writable: the body records its own conversation there. */
	readonly stateDir: string;
	/** The host's data dir: hidden, except the two folders above. */
	readonly dataDir: string;
	/** Seatbelt and none: the private temporary folder on the host (bwrap mounts a tmpfs at /tmp instead). */
	readonly tmpDir: string;
	/** More to hide (seatbelt: never readable; bwrap mounts only the system dirs, so they are not there anyway). */
	readonly hidden?: readonly string[];
	/** Non-secret variables for the body (gardend's MCP URL, pi's switches). Nothing else from the host's env. */
	readonly env: Readonly<Record<string, string>>;
}

export interface BoxLaunch {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
	readonly cwd: string;
	/** What the box is, for the event log (no secrets). */
	readonly describe: Record<string, unknown>;
}

const SYSTEM_PATH = ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/** An executable on the host's PATH, by its absolute path (the box is started without the host's PATH). */
export function findOnPath(name: string, path = process.env.PATH ?? SYSTEM_PATH.join(delimiter)): string | undefined {
	for (const dir of path.split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, name);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// not here
		}
	}
	return undefined;
}

/** The real path when it exists (seatbelt matches resolved paths: /tmp is /private/tmp on macOS). */
function real(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function under(path: string, root: string): boolean {
	return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** The environment a body starts with: a short PATH, its private home and tmp, a locale, the spec's variables. */
function bodyEnv(spec: BoxSpec, home: string, tmp: string): Record<string, string> {
	const nodeBin = dirname(spec.node);
	const path = [...new Set([nodeBin, ...(process.platform === "darwin" ? ["/opt/homebrew/bin"] : []), ...SYSTEM_PATH])];
	return {
		PATH: path.join(delimiter),
		HOME: home,
		TMPDIR: tmp,
		LANG: "C.UTF-8",
		...spec.env,
	};
}

/** bubblewrap's arguments for a box (the command is `bwrap`). */
export function bwrapArgs(spec: BoxSpec): string[] {
	const args = [
		"--unshare-all",
		"--share-net",
		"--die-with-parent",
		"--new-session",
		// A host running as root starts bwrap privileged: the box keeps no capability (it could remount otherwise).
		...(process.getuid?.() === 0 ? ["--cap-drop", "ALL"] : []),
		// A read-only system: the binaries, libraries and /etc (certificates, resolv.conf, passwd), nothing else.
		"--ro-bind",
		"/usr",
		"/usr",
		...["/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"].flatMap((dir) => ["--ro-bind-try", dir, dir]),
		"--ro-bind",
		"/etc",
		"/etc",
		// systemd-resolved hosts (Ubuntu, WSL2) point /etc/resolv.conf here.
		"--ro-bind-try",
		"/run/systemd/resolve",
		"/run/systemd/resolve",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		// The private /tmp, gone with the box.
		"--tmpfs",
		"/tmp",
	];
	const nodePrefix = dirname(dirname(spec.node));
	const readable = [...new Set([...(under(spec.node, "/usr") ? [] : [nodePrefix]), ...spec.readable])];
	for (const path of readable) args.push("--ro-bind", path, path);
	// The data dir is an empty read-only tmpfs in the box (wherever it lives, even under /tmp), with this session's
	// two folders bound writable into it: every other session stays out of sight and out of reach.
	args.push("--tmpfs", spec.dataDir);
	args.push("--bind", spec.workdir, spec.workdir, "--bind", spec.stateDir, spec.stateDir);
	args.push("--remount-ro", spec.dataDir);
	args.push("--chdir", spec.workdir, "--clearenv");
	for (const [name, value] of Object.entries(bodyEnv(spec, "/tmp", "/tmp"))) args.push("--setenv", name, value);
	// The box's own root (the tmpfs bwrap builds it on) is read-only too: nothing outside the binds can be written.
	args.push("--remount-ro", "/");
	args.push("--", spec.node, ...spec.nodeArgs, spec.entry, ...spec.entryArgs);
	return args;
}

const quote = (path: string) => JSON.stringify(path);

/** The paths above `path`, for the metadata lookups node does while it resolves a path (`/a`, `/a/b`, ...). */
function ancestors(path: string): string[] {
	const out: string[] = [];
	let current = dirname(path);
	while (current !== dirname(current)) {
		out.push(current);
		current = dirname(current);
	}
	return out;
}

/**
 * The seatbelt profile (SBPL) for a box: deny by default, then what node, pi and a shell need. Later rules win, so
 * the home folder and the data dir are denied after the broad read rule and the body's own paths allowed after that.
 */
export function seatbeltProfile(spec: BoxSpec): string {
	const home = real(homedir());
	const writable = [spec.workdir, spec.stateDir, spec.tmpDir].map(real);
	const readable = [dirname(dirname(spec.node)), ...spec.readable].map(real);
	// The home folder, the data dir (every other session), and the shared temporary folders, where other programs
	// leave their files: the body's own temporary folder is allowed again below.
	const shared = ["/private/tmp", "/private/var/tmp", real(tmpdir())].filter((path) => existsSync(path));
	const hidden = [...new Set([home, real(spec.dataDir), ...shared, ...(spec.hidden ?? []).map(real)])];
	const lookups = [...new Set([...writable, ...readable].flatMap(ancestors))].filter((path) => hidden.some((root) => under(path, root)));
	return [
		"(version 1)",
		"(deny default)",
		"(allow process-exec)",
		"(allow process-fork)",
		"(allow signal (target same-sandbox))",
		"(allow process-info* (target same-sandbox))",
		"(allow sysctl-read)",
		"(allow file-read*)",
		`(deny file-read* ${hidden.map((path) => `(subpath ${quote(path)})`).join(" ")})`,
		`(allow file-read* ${[...readable, ...writable].map((path) => `(subpath ${quote(path)})`).join(" ")})`,
		...(lookups.length > 0 ? [`(allow file-read-metadata ${lookups.map((path) => `(literal ${quote(path)})`).join(" ")})`] : []),
		`(allow file-write* ${writable.map((path) => `(subpath ${quote(path)})`).join(" ")})`,
		// The folders themselves stay: their contents are the body's, but it cannot remove, rename or replace them
		// (with a link, say, that the host would follow).
		`(deny file-write* ${writable.map((path) => `(literal ${quote(path)})`).join(" ")})`,
		'(allow file-write-data file-ioctl (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/[0-9]+$"))',
		"(allow pseudo-tty)",
		'(allow file-read* file-write* file-ioctl (literal "/dev/ptmx") (regex #"^/dev/ttys[0-9]+$"))',
		"(allow network-outbound)",
		'(allow network-inbound (local ip "localhost:*"))',
		"(allow system-socket)",
		// Name lookups, users and groups, the system's TLS trust and logging. No Launch Services, Apple Events or
		// launchd job submission: those start processes outside the box.
		"(allow mach-lookup",
		'  (global-name "com.apple.dnssd.service")',
		'  (global-name "com.apple.system.opendirectoryd.libinfo")',
		'  (global-name "com.apple.system.opendirectoryd.membership")',
		'  (global-name "com.apple.system.notification_center")',
		'  (global-name "com.apple.SystemConfiguration.configd")',
		'  (global-name "com.apple.trustd.agent")',
		'  (global-name "com.apple.logd")',
		'  (global-name "com.apple.system.logger"))',
		"(allow ipc-posix-sem)",
		'(allow ipc-posix-shm-read-data ipc-posix-shm-read-metadata (ipc-posix-name "apple.shm.notification_center"))',
		"",
	].join("\n");
}

/** How to start the box: the command, its arguments and its environment. */
export function planBox(spec: BoxSpec): BoxLaunch {
	for (const path of [spec.node, spec.entry, spec.workdir, spec.stateDir, spec.dataDir, spec.tmpDir, ...spec.readable]) {
		if (!isAbsolute(path)) throw new Error(`a box path must be absolute: ${path}`);
	}
	const command = [spec.node, ...spec.nodeArgs, spec.entry, ...spec.entryArgs];
	switch (spec.tier) {
		case "bwrap": {
			const bwrap = findOnPath("bwrap");
			if (!bwrap) throw new Error("bwrap is not installed (on Debian and Ubuntu, and in WSL2: sudo apt install bubblewrap)");
			return {
				command: bwrap,
				args: bwrapArgs(spec),
				env: {},
				cwd: spec.workdir,
				describe: { tier: "bwrap", writable: [spec.workdir, spec.stateDir, "/tmp (tmpfs)"], network: "shared" },
			};
		}
		case "seatbelt":
			return {
				command: "/usr/bin/sandbox-exec",
				args: ["-p", seatbeltProfile(spec), ...command],
				env: bodyEnv(spec, real(spec.tmpDir), real(spec.tmpDir)),
				cwd: spec.workdir,
				describe: { tier: "seatbelt", writable: [spec.workdir, spec.stateDir, real(spec.tmpDir)], network: "allowed" },
			};
		case "none":
			return {
				command: command[0] as string,
				args: command.slice(1),
				env: bodyEnv(spec, spec.tmpDir, spec.tmpDir),
				cwd: spec.workdir,
				describe: { tier: "none", unisolated: true },
			};
	}
}

/** Run a box's probe command; resolve with its failure (`undefined`: it ran). */
function run(command: string, args: readonly string[], env: Readonly<Record<string, string>>, cwd: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		let stderr = "";
		let child;
		try {
			child = spawn(command, args, { env, cwd, stdio: ["ignore", "ignore", "pipe"] });
		} catch (error) {
			resolve(error instanceof Error ? error.message : String(error));
			return;
		}
		const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < 4096) stderr += chunk.toString("utf8");
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve(`${command}: ${error.message}`);
		});
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			resolve(code === 0 ? undefined : `${command} exited ${code ?? signal}: ${stderr.trim().split("\n").slice(-3).join(" ") || "(no message)"}`);
		});
	});
}

/**
 * Make one real box of this tier (with `node -e 0` as its body) to learn whether the host can isolate at all: bwrap
 * may be missing, or user namespaces may be off. Resolves with the reason it cannot (`undefined`: it can).
 */
export async function probeTier(tier: BoxTier, spec: Omit<BoxSpec, "tier" | "entry" | "entryArgs" | "nodeArgs">): Promise<string | undefined> {
	if (tier === "none") return undefined;
	if (tier === "seatbelt" && !existsSync("/usr/bin/sandbox-exec")) return "seatbelt needs /usr/bin/sandbox-exec, which this Mac does not have";
	let launch: BoxLaunch;
	try {
		launch = planBox({ ...spec, tier, nodeArgs: [], entry: join(spec.workdir, "probe.mjs"), entryArgs: [] });
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	// The probe's body is `node -e 0`: replace the entry with `-e 0` after the node binary.
	const args = [...launch.args];
	const at = args.lastIndexOf(spec.node);
	args.splice(at + 1, args.length - at - 1, "-e", "0");
	return run(launch.command, args, launch.env, launch.cwd);
}
