#!/usr/bin/env node
/**
 * The body of an isolated session (profile `agent`): what runs inside the box. vehicle-host starts it through the
 * isolation tier (`./isolation.ts`) and speaks to it as `./rpc-body.ts` describes.
 *
 * It is `pi --mode rpc`: pi's own RPC mode (`runRpcMode`, the code behind `pi --mode rpc`) over a session built
 * exactly as the in-process chat body is built (`./session.ts`), with pi-sophia for the `agent` profile. pi's CLI
 * `main` is not used: it would read settings, trust, extensions and skills from the home folder and from the
 * working folder, which the agent writes.
 *
 * 1. The bootstrap arrives on fd 3 and fd 3 is closed: the session's settings and the model key, which goes into
 *    pi's model runtime and nowhere else (not the environment, which the body's shell would inherit).
 * 2. The delegation token is asked for before every request to gardend's `/mcp`, over pi's extension-UI channel
 *    (an `input` request titled `sophia.delegated-token`), so the host always hands the newest one.
 * 3. The tool list (after pi-sophia set it for the run) and a budget stop go to the host as extension statuses.
 */

import { mkdirSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createMcpExtension,
	type ExtensionFactory,
	type ExtensionUIContext,
	ModelRuntime,
	runRpcMode,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	type BudgetStop,
	createSophiaExtension,
	createSophiaMcpTransport,
	type GardendMcpOptions,
	isSophiaProfile,
	isSophiaRole,
	normalizeBudget,
	type SophiaExtensionOptions,
	sophiaExcludedBuiltins,
	sophiaToolAllowlist,
} from "@sophia-labs/pi-sophia";
import { findPiSessionFile } from "./pi-files.ts";

/** Must match `./rpc-body.ts` (not imported, to keep the body free of the host's code). */
const BOOTSTRAP_SCHEMA = "sophia.vehicle-body-bootstrap.v1";
const TOKEN_REQUEST = "sophia.delegated-token";
const TOOLS_STATUS = "vehicle.tools";
const BUDGET_STATUS = "vehicle.budget";
const TOKEN_WAIT_MS = 10_000;

interface Bootstrap {
	readonly schema: string;
	readonly sessionId: string;
	readonly graphId: string;
	readonly role: string;
	readonly profile: string;
	readonly model: { readonly provider: string; readonly id: string };
	readonly budget: unknown;
	readonly workdir: string;
	readonly piDir: string;
	readonly isolation: string;
	modelKey?: string;
	/** A test setting: pi's faux provider answers, scripted by the user's words (`./body-faux.ts`). */
	readonly faux?: boolean;
}

function fail(message: string): never {
	process.stderr.write(`vehicle body: ${message}\n`);
	process.exit(2);
}

/** Read the bootstrap from fd 3 to its end, then close fd 3: nothing started later can inherit it. */
async function readBootstrap(): Promise<Bootstrap> {
	const socket = new Socket({ fd: 3, readable: true, writable: false });
	const chunks: Buffer[] = [];
	for await (const chunk of socket) chunks.push(chunk as Buffer);
	socket.destroy();
	let parsed: Bootstrap;
	try {
		parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Bootstrap;
	} catch {
		fail("the bootstrap on fd 3 is not JSON");
	}
	if (parsed.schema !== BOOTSTRAP_SCHEMA) fail(`unknown bootstrap ${String(parsed.schema)}`);
	if (!isSophiaRole(parsed.role) || !isSophiaProfile(parsed.profile)) fail("the bootstrap's role or profile is not Sophia's");
	return parsed;
}

/** The host, as the body's extensions reach it: pi's extension-UI channel of the RPC mode. */
class Host {
	private ui: ExtensionUIContext | undefined;
	private readonly waiting: ((ui: ExtensionUIContext) => void)[] = [];

	attach(ui: ExtensionUIContext): void {
		this.ui = ui;
		for (const wake of this.waiting.splice(0)) wake(ui);
	}

	private ready(): Promise<ExtensionUIContext> {
		return this.ui ? Promise.resolve(this.ui) : new Promise((resolve) => this.waiting.push(resolve));
	}

	/** The newest delegation token, asked for now (it may have been refreshed since the last request). */
	async token(): Promise<string | undefined> {
		const ui = await this.ready();
		const value = await ui.input(TOKEN_REQUEST, undefined, { timeout: TOKEN_WAIT_MS });
		return value === undefined || value === "" ? undefined : value;
	}

	status(key: string, value: unknown): void {
		this.ui?.setStatus(key, JSON.stringify(value));
	}
}

const boot = await readBootstrap();
const agentDir = join(process.env.TMPDIR || tmpdir(), "pi-agent");
mkdirSync(agentDir, { recursive: true, mode: 0o700 });
mkdirSync(boot.piDir, { recursive: true, mode: 0o700 });

const modelRuntime = await ModelRuntime.create({
	authPath: join(agentDir, "auth.json"),
	modelsPath: null,
	allowModelNetwork: false,
	refreshOnCreate: false,
});
if (boot.faux) {
	const { installBodyFaux } = await import("./body-faux.ts");
	installBodyFaux(modelRuntime);
}
if (boot.modelKey) await modelRuntime.setRuntimeApiKey(boot.model.provider, boot.modelKey);
// The key now lives in pi's model runtime only.
delete boot.modelKey;
const model = modelRuntime.getModel(boot.model.provider, boot.model.id);
if (!model) fail(`model ${boot.model.provider}/${boot.model.id} is not available in the body`);

const host = new Host();
// gardend's loopback `/mcp` (not a secret: the body's environment carries it, as the host's does).
const mcpUrl = process.env.SOPHIA_GARDEND_MCP_URL?.trim();
const gardend: GardendMcpOptions | undefined = mcpUrl ? { url: mcpUrl, getToken: () => host.token() } : undefined;
const sophiaOptions: SophiaExtensionOptions = {
	graphId: boot.graphId,
	role: boot.role as SophiaExtensionOptions["role"] & string,
	profile: boot.profile as SophiaExtensionOptions["profile"] & string,
	...(boot.profile === "agent" ? { agent: { workdir: boot.workdir, isolation: boot.isolation } } : {}),
	...(gardend ? { gardend } : {}),
	budget: normalizeBudget(boot.budget as Parameters<typeof normalizeBudget>[0]),
	onBudgetStop: (stop: BudgetStop) => host.status(BUDGET_STATUS, stop),
};

/** The body's link to its host: it learns the UI channel at session start, reports the tools of each run. */
const bodyExtension: ExtensionFactory = (pi) => {
	pi.on("session_start", (_event, ctx) => {
		host.attach(ctx.ui);
	});
	// After pi-sophia's own handler (extensions run in order): the tools it activated for this run.
	pi.on("before_agent_start", () => {
		host.status(TOOLS_STATUS, pi.getActiveTools());
		return undefined;
	});
};

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir: dir, sessionManager, sessionStartEvent }) => {
	const settingsManager = SettingsManager.inMemory({ enableInstallTelemetry: false, retry: { enabled: true, maxRetries: 2 } });
	const services = await createAgentSessionServices({
		cwd,
		agentDir: dir,
		settingsManager,
		modelRuntime,
		resourceLoaderOptions: {
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [
				{
					name: "mcp",
					factory: createMcpExtension({
						// Only the servers pi-sophia registers: never an mcp.json from the box.
						loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: false }),
						logPath: join(boot.piDir, "mcp.log"),
						...(gardend ? { createTransport: createSophiaMcpTransport(gardend) } : {}),
					}),
				},
				{ name: "sophia", factory: createSophiaExtension(sophiaOptions) },
				{ name: "vehicle-body", factory: bodyExtension },
			],
		},
	});
	const created = await createAgentSessionFromServices({
		services,
		sessionManager,
		...(sessionStartEvent ? { sessionStartEvent } : {}),
		model,
		thinkingLevel: "off",
		tools: sophiaToolAllowlist(sophiaOptions),
		excludeTools: [...sophiaExcludedBuiltins(sophiaOptions.profile)],
	});
	return { ...created, services, diagnostics: services.diagnostics };
};

const file = findPiSessionFile(boot.piDir);
const sessionManager = file ? SessionManager.open(file, boot.piDir, boot.workdir) : SessionManager.create(boot.workdir, boot.piDir, { id: boot.sessionId });
const runtime = await createAgentSessionRuntime(createRuntime, { cwd: boot.workdir, agentDir, sessionManager });
await runRpcMode(runtime);
