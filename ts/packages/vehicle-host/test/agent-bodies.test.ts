/**
 * `agent` sessions: an isolated `pi --mode rpc` body per session, in the host's isolation tier, with pi's `read`,
 * `write`, `edit` and `bash` on the session's own working folder. Real children in real boxes (seatbelt on macOS,
 * bubblewrap on Linux), driven over real HTTP; the model is pi's faux provider inside the body, scripted by the
 * prompt (`src/body-faux.ts`: `[tool <name> <json>]`, `[hold]`, `[slow <ms>]`).
 *
 * The red check is the same escape battery with isolation off (`none`, opted in): there the writes outside the
 * workspace land on the host, so the battery is seen to catch an escape.
 */

import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { type IsolationSetting, type IsolationTier, isolationSetting, planBox, seatbeltProfile, settingRefusal, workspaceDir } from "../src/index.ts";
import { createSession, DRIVER, type Harness, type Identity, startHost } from "./harness.ts";

/** The box this platform makes: seatbelt on macOS, bubblewrap on Linux (`VEHICLE_TEST_TIER` overrides). */
const PLATFORM_TIER = (process.env.VEHICLE_TEST_TIER as IsolationTier | undefined) ?? (process.platform === "darwin" ? "seatbelt" : process.platform === "linux" ? "bwrap" : undefined);
const boxed = (tier: IsolationTier, allowUnisolatedAgent = false): IsolationSetting => ({ tier, source: "VEHICLE_ISOLATION", allowUnisolatedAgent });
/** A model key no one else has: it must never show up inside the box. */
const MODEL_KEY = `faux-key-${Math.random().toString(36).slice(2)}-never-in-the-box`;

type Events = Awaited<ReturnType<Harness["events"]>>;

const bash = (command: string) => `[tool bash ${JSON.stringify({ command })}]`;
const write = (path: string, content: string) => `[tool write ${JSON.stringify({ path, content })}]`;

/** Send one prompt and wait until it settles; the events since just before it. */
async function turn(harness: Harness, sessionId: string, text: string, who: Identity = DRIVER): Promise<Events> {
	const mark = (await harness.events(sessionId, 0, who)).at(-1)?.seq ?? 0;
	const requestId = `p-${Math.random().toString(36).slice(2)}`;
	const sent = await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId, op: "prompt", text }, who);
	assert.equal(sent.status, 200, JSON.stringify(sent.body));
	await harness.waitFor(sessionId, (event) => event.seq > mark && /^command\.(completed|failed|aborted)$/.test(event.type) && event.payload.commandId === requestId, 60_000, who);
	await harness.waitFor(sessionId, (event) => event.seq > mark && event.type === "run.settled", 30_000, who);
	return harness.events(sessionId, mark, who);
}

const results = (events: Events) => events.filter((event) => event.type === "tool.result").map((event) => event.payload as { toolName: string; isError: boolean; text: string });

/**
 * Every way out the battery tries, as host paths. `boxTmp`: the path is the box's own private /tmp (bubblewrap
 * mounts a tmpfs there), so a write may succeed in the box; it must still never reach the host.
 */
function escapeTargets(harness: Harness, self: string, other: string, withHome: boolean): { label: string; path: string; boxTmp?: boolean }[] {
	const tag = Math.random().toString(36).slice(2);
	return [
		...(withHome ? [{ label: "the home folder", path: join(homedir(), `vehicle-escape-${tag}.txt`) }] : []),
		{ label: "/etc", path: `/etc/vehicle-escape-${tag}` },
		{ label: "another session's workspace", path: join(workspaceDir(harness.dataDir, other), `escape-${tag}.txt`) },
		{ label: "another session's pi folder", path: join(harness.dataDir, "sessions", other, "pi", `escape-${tag}.jsonl`) },
		{ label: "this session's own record", path: join(harness.dataDir, "sessions", self, `escape-${tag}.json`) },
		{ label: "the shared temporary folder", path: join(tmpdir(), `vehicle-escape-${tag}.txt`), boxTmp: tmpdir() === "/tmp" },
	];
}

/** Try each target with pi's `write` tool and with the shell; report what reached the host. */
async function attemptEscapes(harness: Harness, sessionId: string, targets: { label: string; path: string; boxTmp?: boolean }[]) {
	const outcome: { label: string; path: string; boxTmp?: boolean; writeTool: { isError: boolean; text: string }; shell: string; onHost: boolean }[] = [];
	for (const target of targets) {
		const shellPath = `${target.path}.sh`;
		const events = await turn(harness, sessionId, `${write(target.path, "escaped")} ${bash(`printf escaped > '${shellPath}' && echo WROTE || echo REFUSED`)}`);
		const [writeTool, shell] = results(events);
		const onHost = existsSync(target.path) || existsSync(shellPath);
		outcome.push({ ...target, writeTool: writeTool ?? { isError: true, text: "(no result)" }, shell: shell?.text ?? "(no result)", onHost });
		rmSync(target.path, { force: true });
		rmSync(shellPath, { force: true });
	}
	return outcome;
}

describe(`agent bodies in a ${PLATFORM_TIER ?? "(no)"} box`, { skip: PLATFORM_TIER ? false : "no box on this platform" }, () => {
	const tier = PLATFORM_TIER as IsolationTier;
	let harness: Harness;
	let self: string;
	let other: string;

	before(async () => {
		harness = await startHost({ agentBodies: { isolation: boxed(tier) }, fauxKey: MODEL_KEY });
		const status = await harness.host.agentStatus();
		assert.equal(status.refusal, undefined, `this host cannot make a ${tier} box: ${status.refusal}`);
		other = await createSession(harness, { profile: "agent", title: "the other session" }, { ...DRIVER, clientId: "other-tab" });
		await turn(harness, other, "OTHER-SESSION-WORDS", { ...DRIVER, clientId: "other-tab" });
		writeFileSync(join(harness.dataDir, "sessions", other, "secret.txt"), "OTHER-SESSION-SECRET");
		self = await createSession(harness, { profile: "agent" });
	});
	after(async () => harness?.cleanup());

	it("runs pi's tools inside the box: write a file in the workspace, then read it back with the shell", async () => {
		const events = await turn(harness, self, `${write("hello.txt", "hello from the box")} ${bash("cat hello.txt && pwd")}`);
		const materialized = events.find((event) => event.type === "body.materialized");
		assert.equal(materialized?.payload.kind, "rpc");
		assert.equal((materialized?.payload.box as { tier: string }).tier, tier);
		const started = events.find((event) => event.type === "run.started");
		assert.deepEqual([...(started?.payload.tools as string[])].sort(), ["bash", "edit", "read", "write"]);
		const [wrote, shell] = results(events);
		assert.equal(wrote?.isError, false, wrote?.text);
		assert.equal(shell?.isError, false, shell?.text);
		assert.match(shell?.text ?? "", /hello from the box/);
		assert.equal(readFileSync(join(workspaceDir(harness.dataDir, self), "hello.txt"), "utf8"), "hello from the box");
		const inspected = await harness.call("GET", `/sessions/${self}`);
		assert.equal(inspected.body.value.session.profile, "agent");
		assert.equal(inspected.body.value.session.isolation, tier);
	});

	it("refuses every write outside the workspace, and nothing reaches the host", async () => {
		const outcome = await attemptEscapes(harness, self, escapeTargets(harness, self, other, true));
		for (const attempt of outcome) {
			assert.equal(attempt.onHost, false, `${attempt.label}: a file reached the host (${attempt.path})`);
			// bubblewrap's /tmp is the box's own: a write there stays in the box (and is checked above).
			if (tier === "bwrap" && attempt.boxTmp) continue;
			assert.equal(attempt.writeTool.isError, true, `${attempt.label}: pi's write tool succeeded: ${attempt.writeTool.text}`);
			assert.match(attempt.shell, /REFUSED/, `${attempt.label}: ${attempt.shell}`);
			assert.match(`${attempt.writeTool.text} ${attempt.shell}`, /not permitted|Read-only file system|No such file or directory|Permission denied|EROFS|EPERM|EACCES|ENOENT/i);
		}
		assert.match(readFileSync(join(harness.dataDir, "sessions", self, "meta.json"), "utf8"), /"profile": "agent"/);
		if (process.platform === "linux") {
			// Even a host running as root gets a box without capabilities (no remounting its way out).
			const caps = results(await turn(harness, self, bash("grep CapEff /proc/self/status; mount -o remount,rw /etc 2>&1 || echo NO-REMOUNT")))[0]?.text ?? "";
			assert.match(caps, /CapEff:\s+0000000000000000/);
			assert.match(caps, /NO-REMOUNT/);
		}
	});

	it("hides other sessions and the home folder from reads", async () => {
		const secret = join(harness.dataDir, "sessions", other, "secret.txt");
		const events = await turn(harness, self, `${bash(`cat '${secret}' || echo CANNOT-READ`)} ${bash(`ls -A '${homedir()}' || echo CANNOT-LIST`)} ${bash(`ls '${join(harness.dataDir, "sessions")}' || echo CANNOT-LIST-SESSIONS`)}`);
		const [read, home, sessions] = results(events);
		assert.doesNotMatch(read?.text ?? "", /OTHER-SESSION-SECRET/);
		assert.match(read?.text ?? "", /CANNOT-READ/);
		// The home folder is unreadable (seatbelt), or only the skeleton bubblewrap makes to mount the box's own
		// folders when they live under it (the body's code, the data dir): none of the home's real entries.
		const skeleton = new Set(
			[harness.dataDir, tmpdir(), ...(process.env.VEHICLE_BODY_ENTRY ? [process.env.VEHICLE_BODY_ENTRY] : [new URL("../../..", import.meta.url).pathname])]
				.filter((path) => path.startsWith(`${homedir()}/`))
				.map((path) => path.slice(homedir().length + 1).split("/")[0]),
		);
		const listed = /CANNOT-LIST/.test(home?.text ?? "") ? [] : (home?.text ?? "").split("\n").filter(Boolean);
		for (const entry of listed) assert.ok(skeleton.has(entry), `the box sees ${entry} in the home folder`);
		assert.doesNotMatch(sessions?.text ?? "", new RegExp(other));
	});

	it("gives the shell no secret: the model key is in neither its environment nor pi's", async () => {
		const events = await turn(harness, self, bash("env; echo ---; tr '\\0' '\\n' < /proc/$PPID/environ 2>/dev/null; tr '\\0' ' ' < /proc/$PPID/cmdline 2>/dev/null; echo"));
		const [shell] = results(events);
		assert.equal(shell?.isError, false, shell?.text);
		assert.match(shell?.text ?? "", /PATH=/);
		assert.doesNotMatch(shell?.text ?? "", new RegExp(MODEL_KEY));
		assert.doesNotMatch(shell?.text ?? "", /sophia-dlg-|MNEMOSYNE_|OPENROUTER_API_KEY/);
		// The body did use the key: pi's preflight refuses a prompt for a provider without one.
		assert.ok(events.some((event) => event.type === "run.settled" && event.payload.aborted === false));
	});

	it("steers a running body: the steer is taken inside the same run", async () => {
		const mark = (await harness.events(self)).at(-1)?.seq ?? 0;
		await harness.call("POST", `/sessions/${self}/commands`, { requestId: "slow-1", op: "prompt", text: "[slow 1500] Start the long task" });
		await harness.waitFor(self, (event) => event.seq > mark && event.type === "run.started");
		const steer = await harness.call("POST", `/sessions/${self}/commands`, { requestId: "steer-1", op: "steer", text: "Focus on the second item" });
		assert.equal(steer.status, 200, JSON.stringify(steer.body));
		assert.equal(steer.body.value.command.status, "queued");
		await harness.waitFor(self, (event) => event.seq > mark && event.type === "command.completed" && event.payload.commandId === "steer-1", 30_000);
		const events = await harness.events(self, mark);
		const delivered = events.filter((event) => event.type === "command.delivered");
		assert.equal(delivered.length, 2);
		assert.equal(delivered[0]?.payload.runId, delivered[1]?.payload.runId, "the steer joined the running run");
		const answers = events.filter((event) => event.type === "message.completed" && event.payload.role === "assistant").map((event) => event.payload.text);
		assert.match(answers.at(-1) as string, /faux heard: Focus on the second item/);
	});

	it("aborts a running body, and the same body goes on", async () => {
		const mark = (await harness.events(self)).at(-1)?.seq ?? 0;
		await harness.call("POST", `/sessions/${self}/commands`, { requestId: "hold-1", op: "prompt", text: "[hold] wait for me" });
		await harness.waitFor(self, (event) => event.seq > mark && event.type === "run.started");
		const startedAt = Date.now();
		const abort = await harness.call("POST", `/sessions/${self}/commands`, { requestId: "abort-1", op: "abort" });
		assert.equal(abort.status, 200, JSON.stringify(abort.body));
		assert.equal(abort.body.value.command.result.abortedRun, true);
		const settled = await harness.waitFor(self, (event) => event.seq > mark && event.type === "run.settled");
		assert.equal(settled.payload.aborted, true);
		assert.ok(Date.now() - startedAt < 9_000, "pi's abort stopped the held model call");
		const after = await turn(harness, self, bash("echo still-here"));
		assert.match(results(after)[0]?.text ?? "", /still-here/);
		const all = await harness.events(self, mark);
		assert.equal(all.filter((event) => event.type === "body.materialized" || event.type === "body.exited").length, 0, "the same body throughout");
	});

	it("reports a body that dies, ends its run, and brings a new body from pi's file at the next command", async () => {
		const mark = (await harness.events(self)).at(-1)?.seq ?? 0;
		await harness.call("POST", `/sessions/${self}/commands`, { requestId: "die-1", op: "prompt", text: bash("kill -9 $PPID") });
		const exited = await harness.waitFor(self, (event) => event.seq > mark && event.type === "body.exited", 30_000);
		assert.ok(exited.payload.signal === "SIGKILL" || exited.payload.code !== 0, JSON.stringify(exited.payload));
		const failed = await harness.waitFor(self, (event) => event.seq > mark && event.type === "command.failed" && event.payload.commandId === "die-1");
		assert.match(String(failed.payload.error), /the body exited/);
		const settled = await harness.waitFor(self, (event) => event.seq > mark && event.type === "run.settled");
		assert.equal(settled.payload.stopReason, "body_exited");
		const next = await turn(harness, self, bash("cat hello.txt"));
		const materialized = next.find((event) => event.type === "body.materialized");
		assert.equal(materialized?.payload.resumedFromFile, true);
		assert.match(results(next)[0]?.text ?? "", /hello from the box/);
	});

	it("clones a session with a copy of its workspace: the two then go their own ways", async () => {
		const cloned = await harness.call("POST", `/sessions/${self}/commands`, { requestId: "clone-1", op: "clone" });
		assert.equal(cloned.status, 200, JSON.stringify(cloned.body));
		const clone = cloned.body.value.session.sessionId as string;
		assert.equal(cloned.body.value.session.profile, "agent");
		assert.deepEqual(cloned.body.value.workspace, { copied: true });
		assert.equal(readFileSync(join(workspaceDir(harness.dataDir, clone), "hello.txt"), "utf8"), "hello from the box");
		const events = await turn(harness, clone, `${write("hello.txt", "the clone's own")} ${bash("cat hello.txt")}`);
		assert.match(results(events)[1]?.text ?? "", /the clone's own/);
		assert.equal(readFileSync(join(workspaceDir(harness.dataDir, self), "hello.txt"), "utf8"), "hello from the box");
	});

	it("never follows a link the body puts in its own pi folder", async () => {
		const otherFile = harness.host.piFileOf(other) as string;
		assert.ok(otherFile && readFileSync(otherFile, "utf8").includes("OTHER-SESSION-WORDS"));
		const link = join(harness.dataDir, "sessions", self, "pi", "zzzz-link.jsonl");
		const events = await turn(harness, self, bash(`ln -s '${otherFile}' '${link}' && echo LINKED`));
		assert.match(results(events)[0]?.text ?? "", /LINKED/);
		assert.ok(lstatSync(link).isSymbolicLink(), "the body made the link (the test is not vacuous)");
		const inspected = await harness.call("GET", `/sessions/${self}`);
		assert.doesNotMatch(JSON.stringify(inspected.body.value.transcript), /OTHER-SESSION-WORDS/);
		assert.match(JSON.stringify(inspected.body.value.transcript), /hello from the box/);
		const capsule = await harness.call("GET", `/sessions/${self}/capsule`);
		assert.doesNotMatch(JSON.stringify(capsule.body), /OTHER-SESSION-WORDS/);
	});

	it("revives an agent session after the host restarts: its workspace and its conversation", async () => {
		const dataDir = harness.dataDir;
		await harness.stop();
		harness = await startHost({ dataDir, agentBodies: { isolation: boxed(tier) }, fauxKey: MODEL_KEY });
		const inspected = await harness.call("GET", `/sessions/${self}`);
		assert.equal(inspected.body.value.session.status, "dormant");
		await harness.call("POST", `/sessions/${self}/claim`, { requestId: "claim-after-restart", takeover: true });
		const events = await turn(harness, self, bash("cat hello.txt"));
		assert.equal(events.find((event) => event.type === "body.materialized")?.payload.resumedFromFile, true);
		assert.match(results(events)[0]?.text ?? "", /hello from the box/);
		const transcript = (await harness.call("GET", `/sessions/${self}`)).body.value.transcript as { role: string; text: string }[];
		assert.ok(transcript.some((item) => item.role === "user" && /Start the long task/.test(item.text)), "pi's context came back from its file");
	});

	it("moves an agent's workspace to the trash with its session", async () => {
		const removed = await harness.call("DELETE", `/sessions/${self}`);
		assert.equal(removed.status, 200, JSON.stringify(removed.body));
		assert.equal(existsSync(workspaceDir(harness.dataDir, self)), false);
		assert.equal(readFileSync(join(harness.dataDir, "trash", removed.body.value.trashedAs, "workspace", "hello.txt"), "utf8"), "hello from the box");
	});
});

describe("the escape battery with isolation off (the red check)", () => {
	let harness: Harness;
	before(async () => {
		harness = await startHost({ agentBodies: { isolation: boxed("none", true) } });
	});
	after(async () => harness?.cleanup());

	it("sees the writes outside the workspace land on the host when there is no box", async () => {
		const other = await createSession(harness, { profile: "agent" }, { ...DRIVER, clientId: "other-tab" });
		const self = await createSession(harness, { profile: "agent" });
		// Not the home folder: an unisolated body really would write there.
		const outcome = await attemptEscapes(harness, self, escapeTargets(harness, self, other, false));
		const escaped = outcome.filter((attempt) => attempt.onHost).map((attempt) => attempt.label);
		for (const label of ["another session's workspace", "another session's pi folder", "this session's own record", "the shared temporary folder"]) {
			assert.ok(escaped.includes(label), `without a box, ${label} should be reachable (escaped: ${escaped.join(", ")})`);
		}
	});
});

describe("who may start an agent session", () => {
	let harness: Harness;
	before(async () => {
		harness = await startHost({ agentBodies: { isolation: PLATFORM_TIER ? boxed(PLATFORM_TIER) : boxed("none", true) } });
	});
	after(async () => harness?.cleanup());

	it("refuses members and viewers (403), and lets them chat", async () => {
		for (const role of ["editor", "viewer"]) {
			const who = { principal: `a-${role}`, role, clientId: `${role}-tab` };
			const refused = await harness.call("POST", "/sessions", { requestId: `agent-${role}`, profile: "agent" }, who);
			assert.equal(refused.status, 403, JSON.stringify(refused.body));
			assert.equal(refused.body.code, "forbidden_profile");
			const chat = await harness.call("POST", "/sessions", { requestId: `chat-${role}`, profile: "chat" }, who);
			assert.equal(chat.status, 201, JSON.stringify(chat.body));
			assert.equal(chat.body.value.session.profile, "chat");
		}
		const owner = await harness.call("POST", "/sessions", { requestId: "agent-owner", profile: "agent" });
		assert.equal(owner.status, 201, JSON.stringify(owner.body));
		assert.equal(owner.body.value.session.profile, "agent");
		const listed = await harness.call("GET", "/sessions");
		assert.deepEqual(
			(listed.body.value.sessions as { profile: string }[]).map((session) => session.profile),
			["agent"],
		);
	});

	it("refuses the owner's own agent session once their role is no longer owner", async () => {
		const sessionId = await createSession(harness, { profile: "agent" });
		const demoted = await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: "as-editor", op: "prompt", text: "hi" }, { ...DRIVER, role: "editor" });
		assert.equal(demoted.status, 403, JSON.stringify(demoted.body));
		assert.equal(demoted.body.code, "access_reduced");
	});

	it("refuses an unknown profile", async () => {
		const refused = await harness.call("POST", "/sessions", { requestId: "worker", profile: "worker" });
		assert.equal(refused.status, 400);
	});
});

describe("isolation is a setting", () => {
	it("refuses agent sessions where the host cannot isolate them, with the reason", async () => {
		const cases: [IsolationSetting, RegExp][] = [
			[boxed("none"), /VEHICLE_ISOLATION is none.*VEHICLE_AGENT_UNISOLATED=1/],
			[boxed("microvm"), /microvm needs KVM and is not implemented yet/],
			[boxed(process.platform === "darwin" ? "bwrap" : "seatbelt"), /needs (Linux|macOS)/],
		];
		for (const [isolation, reason] of cases) {
			const harness = await startHost({ agentBodies: { isolation } });
			try {
				const refused = await harness.call("POST", "/sessions", { requestId: `agent-${isolation.tier}`, profile: "agent" });
				assert.equal(refused.status, 503, JSON.stringify(refused.body));
				assert.equal(refused.body.code, "isolation_unavailable");
				assert.match(refused.body.message, reason);
				const chat = await harness.call("POST", "/sessions", { requestId: `chat-${isolation.tier}` });
				assert.equal(chat.status, 201, "chat does not need a box");
			} finally {
				await harness.cleanup();
			}
		}
	});

	it("defaults to the platform's box and refuses an unknown tier", () => {
		assert.equal(isolationSetting({}, "linux").tier, "bwrap");
		assert.equal(isolationSetting({}, "darwin").tier, "seatbelt");
		assert.equal(isolationSetting({}, "win32").tier, "none");
		assert.equal(isolationSetting({ VEHICLE_ISOLATION: "none", VEHICLE_AGENT_UNISOLATED: "1" }, "linux").allowUnisolatedAgent, true);
		assert.throws(() => isolationSetting({ VEHICLE_ISOLATION: "docker" }, "linux"), /must be one of none, bwrap, seatbelt, microvm/);
		assert.equal(settingRefusal(boxed("none", true), "linux"), undefined);
	});

	it("plans boxes that keep the data dir, the home folder and the environment out", () => {
		const spec = {
			node: "/usr/bin/node",
			nodeArgs: [],
			entry: "/srv/app/main.mjs",
			entryArgs: ["--vehicle-body"],
			readable: ["/srv/app"],
			workdir: "/data/workspaces/s1",
			stateDir: "/data/sessions/s1/pi",
			dataDir: "/data",
			tmpDir: "/tmp",
			env: { SOPHIA_GARDEND_MCP_URL: "http://127.0.0.1:7674/mcp" },
		};
		if (process.platform === "linux") {
			const plan = planBox({ ...spec, tier: "bwrap" });
			const args = plan.args.join(" ");
			assert.match(args, /--unshare-all --share-net --die-with-parent/);
			assert.match(args, /--tmpfs \/data --bind \/data\/workspaces\/s1 \/data\/workspaces\/s1 --bind \/data\/sessions\/s1\/pi \/data\/sessions\/s1\/pi --remount-ro \/data/);
			assert.match(args, /--clearenv/);
			assert.match(args, /--remount-ro \/ -- \/usr\/bin\/node \/srv\/app\/main.mjs --vehicle-body$/);
			assert.doesNotMatch(args, /\/home|--bind \/ /);
		}
		const profile = seatbeltProfile({ ...spec, tier: "seatbelt" });
		assert.match(profile, /^\(version 1\)\n\(deny default\)/);
		assert.match(profile, /\(deny file-read\* \(subpath "[^"]+"\)/);
		assert.doesNotMatch(profile, /launchservicesd|appleevents/);
		const none = planBox({ ...spec, tier: "none" });
		assert.deepEqual(Object.keys(none.env).sort(), ["HOME", "LANG", "PATH", "SOPHIA_GARDEND_MCP_URL", "TMPDIR"]);
	});
});
