/**
 * The host's side of an isolated body: `pi --mode rpc`'s protocol (pi's own `runRpcMode`, see `./body-entry.ts`)
 * over the stdio of a child started inside an isolation box (`./isolation.ts`).
 *
 * Channels, and what crosses each:
 *   fd 3 (a pipe, host to body, closed by both sides as soon as it is read): the bootstrap. The session's settings
 *        and a grant on the host's model proxy (`./model-proxy.ts`): a base URL and a token for this body's model
 *        calls. The model key itself never enters the box; the proxy adds it on the host. The token is in neither
 *        the environment, the arguments nor any file, and the pipe is gone before any tool runs.
 *   stdin/stdout: pi's RPC records. Commands (`prompt`, `steer`, `follow_up`, `abort`, `clear_queue`,
 *        `get_state`, `get_session_stats`) and their responses; pi's session events; and pi's extension-UI records,
 *        which carry the delegation token: before every request to gardend's `/mcp`, the body's MCP client asks
 *        (`extension_ui_request`, method `input`, title `sophia.delegated-token`) and the host answers with the
 *        newest token its person handed (`extension_ui_response`). So the token is refreshed by the person's own
 *        requests exactly as for an in-process body, and it never touches a disk. pi's bash tool gives its shell
 *        no stdin, so a shell in the box does not inherit the channel.
 *   stderr: the body's diagnostics; the last few kilobytes are kept for a crash report.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { BudgetStop } from "@sophia-labs/pi-sophia";
import type { BodyStats, PiBody } from "./body.ts";
import type { BoxLaunch } from "./isolation.ts";

/** The extension-UI titles the body's own extension uses to talk to its host (`./body-entry.ts`). */
export const TOKEN_REQUEST = "sophia.delegated-token";
export const TOOLS_STATUS = "vehicle.tools";
export const BUDGET_STATUS = "vehicle.budget";
export const BOOTSTRAP_SCHEMA = "sophia.vehicle-body-bootstrap.v1";

const START_TIMEOUT_MS = 60_000;
const EXIT_GRACE_MS = 3_000;
const STDERR_KEEP = 8 * 1024;

export interface BodyExit {
	readonly code: number | null;
	readonly signal: string | null;
	/** The host ended it (dispose), rather than the body dying by itself. */
	readonly expected: boolean;
	readonly stderrTail: string;
}

export interface RpcBodyOptions {
	readonly launch: BoxLaunch;
	readonly isolation: string;
	/** Sent once over fd 3. Holds the model proxy's token for this body: never logged. */
	readonly bootstrap: Record<string, unknown>;
	/** The newest delegation token for this session (memory only), or none. */
	readonly getToken: () => string | undefined;
	/** Something the body's extensions told the person (pi's `notify`): bounded, for the event log. */
	readonly onNotice?: (notice: { message: string; level: string }) => void;
	readonly onExtensionError?: (error: { extension: string; event: string; message: string }) => void;
	/** pi-sophia's budget guard stopped a run (its `onBudgetStop`, reported as an extension status). */
	readonly onBudgetStop?: (stop: BudgetStop) => void;
	/** The body ended. Not called for an end the host asked for (`dispose`). */
	readonly onExit: (exit: BodyExit) => void;
	/** Cleanup after the process is gone (the private tmp of a seatbelt box). */
	readonly afterExit?: () => void;
	readonly startTimeoutMs?: number;
}

interface Pending {
	readonly command: string;
	resolve(data: unknown): void;
	reject(error: Error): void;
}

export class RpcBody implements PiBody {
	readonly kind = "rpc" as const;
	readonly isolation: string;
	sessionId = "";
	isStreaming = false;
	pendingMessageCount = 0;
	readonly sessionFile = undefined;
	private readonly child: ChildProcess;
	private readonly options: RpcBodyOptions;
	private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
	private readonly pending = new Map<string, Pending>();
	private nextId = 0;
	private tools: string[] = [];
	private cachedStats: BodyStats | undefined;
	private stderr = "";
	private disposing = false;
	private exited: Promise<BodyExit>;

	private constructor(child: ChildProcess, options: RpcBodyOptions) {
		this.child = child;
		this.options = options;
		this.isolation = options.isolation;
		this.exited = new Promise((resolve) => {
			child.once("exit", (code, signal) => {
				const exit: BodyExit = { code, signal, expected: this.disposing, stderrTail: this.stderr.slice(-2048) };
				for (const pending of this.pending.values()) pending.reject(new Error(`the body exited (${code ?? signal}) before it answered ${pending.command}`));
				this.pending.clear();
				this.isStreaming = false;
				options.afterExit?.();
				if (!exit.expected) options.onExit(exit);
				resolve(exit);
			});
		});
	}

	/** Start a body: spawn the box, hand it the bootstrap, wait until pi answers. */
	static async start(options: RpcBodyOptions): Promise<RpcBody> {
		const { launch } = options;
		const child = spawn(launch.command, [...launch.args], {
			cwd: launch.cwd,
			env: { ...launch.env },
			stdio: ["pipe", "pipe", "pipe", "pipe"],
		});
		const body = new RpcBody(child, options);
		const spawned = new Promise<void>((resolve, reject) => {
			child.once("spawn", () => resolve());
			child.once("error", reject);
		});
		await spawned;
		body.listen();
		const bootstrap = child.stdio[3] as NodeJS.WritableStream | null;
		if (!bootstrap) throw new Error("the body has no bootstrap pipe");
		bootstrap.end(`${JSON.stringify({ schema: BOOTSTRAP_SCHEMA, ...options.bootstrap })}\n`);
		const timeout = options.startTimeoutMs ?? START_TIMEOUT_MS;
		let timer: NodeJS.Timeout | undefined;
		try {
			const state = (await Promise.race([
				body.send({ type: "get_state" }),
				body.exited.then((exit) => {
					throw new Error(`the body exited (${exit.code ?? exit.signal}) while starting: ${exit.stderrTail.trim().split("\n").slice(-4).join(" ") || "(no message)"}`);
				}),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error(`the body did not start within ${timeout} ms`)), timeout);
				}),
			])) as { sessionId?: string; isStreaming?: boolean; pendingMessageCount?: number };
			body.sessionId = String(state.sessionId ?? "");
			body.isStreaming = state.isStreaming === true;
			body.pendingMessageCount = Number(state.pendingMessageCount ?? 0);
			return body;
		} catch (error) {
			await body.dispose();
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}

	private listen(): void {
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		// pi's RPC framing: LF only (U+2028 and U+2029 may sit inside a JSON string).
		this.child.stdout?.on("data", (chunk: Buffer) => {
			buffer += decoder.write(chunk);
			for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
				const line = buffer.slice(0, newline).replace(/\r$/, "");
				buffer = buffer.slice(newline + 1);
				if (line.trim() !== "") this.onLine(line);
			}
		});
		this.child.stderr?.on("data", (chunk: Buffer) => {
			this.stderr = (this.stderr + chunk.toString("utf8")).slice(-STDERR_KEEP);
		});
		this.child.stdin?.on("error", () => undefined);
		(this.child.stdio[3] as NodeJS.WritableStream | null)?.on("error", () => undefined);
	}

	private onLine(line: string): void {
		let record: Record<string, unknown>;
		try {
			record = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return;
		}
		switch (record.type) {
			case "response": {
				const id = typeof record.id === "string" ? record.id : undefined;
				const pending = id === undefined ? undefined : this.pending.get(id);
				if (!pending || id === undefined) return;
				this.pending.delete(id);
				if (record.success === true) pending.resolve(record.data);
				else pending.reject(new Error(String(record.error ?? `${pending.command} failed`)));
				return;
			}
			case "extension_ui_request":
				this.onUiRequest(record);
				return;
			case "extension_error":
				this.options.onExtensionError?.({
					extension: String(record.extensionPath ?? ""),
					event: String(record.event ?? ""),
					message: String(record.error ?? ""),
				});
				return;
			default:
				this.onEvent(record as unknown as AgentSessionEvent);
		}
	}

	/** pi's extension UI, as the body's extensions use it: the token request, the tool list, notices. */
	private onUiRequest(record: Record<string, unknown>): void {
		const id = String(record.id ?? "");
		const answer = (response: Record<string, unknown>) => this.write({ type: "extension_ui_response", id, ...response });
		switch (record.method) {
			case "input": {
				if (record.title === TOKEN_REQUEST) {
					const token = this.options.getToken();
					answer(token === undefined ? { cancelled: true } : { value: token });
				} else answer({ cancelled: true });
				return;
			}
			case "select":
			case "confirm":
			case "editor":
				// Nobody sits at a body's dialogs: every question is answered "cancelled".
				answer({ cancelled: true });
				return;
			case "setStatus": {
				if (typeof record.statusText !== "string") return;
				let value: unknown;
				try {
					value = JSON.parse(record.statusText);
				} catch {
					return;
				}
				if (record.statusKey === TOOLS_STATUS && Array.isArray(value)) {
					this.tools = value.filter((tool): tool is string => typeof tool === "string");
				} else if (record.statusKey === BUDGET_STATUS && value && typeof value === "object") {
					this.options.onBudgetStop?.(value as BudgetStop);
				}
				return;
			}
			case "notify":
				this.options.onNotice?.({ message: String(record.message ?? "").slice(0, 2048), level: String(record.notifyType ?? "info") });
				return;
			default:
				return;
		}
	}

	private onEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
				this.isStreaming = true;
				break;
			case "agent_settled":
				this.isStreaming = false;
				void this.refreshStats();
				break;
			case "queue_update":
				this.pendingMessageCount = event.steering.length + event.followUp.length;
				break;
			default:
				break;
		}
		for (const listener of this.listeners) listener(event);
	}

	private write(record: Record<string, unknown>): void {
		if (this.child.stdin?.writable) this.child.stdin.write(`${JSON.stringify(record)}\n`);
	}

	/** One RPC command; resolves with its response's data. */
	private send(command: Record<string, unknown> & { type: string }): Promise<unknown> {
		if (this.child.exitCode !== null || this.child.signalCode !== null || !this.child.stdin?.writable) {
			return Promise.reject(new Error(`the body is gone; cannot ${command.type}`));
		}
		const id = `h-${++this.nextId}`;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { command: command.type, resolve, reject });
			this.write({ ...command, id });
		});
	}

	private async refreshStats(): Promise<void> {
		try {
			const stats = (await this.send({ type: "get_session_stats" })) as { tokens?: unknown; cost?: number };
			this.cachedStats = { tokens: stats.tokens, costUsd: Number(stats.cost ?? 0) };
		} catch {
			// the body went away
		}
	}

	activeToolNames(): string[] {
		return [...this.tools];
	}

	stats(): BodyStats | undefined {
		return this.cachedStats;
	}

	branch(): undefined {
		return undefined;
	}

	async prompt(text: string, _onRunError: (message: string) => void): Promise<string> {
		const data = (await this.send({ type: "prompt", message: text })) as { disposition?: string } | undefined;
		const disposition = String(data?.disposition ?? "started");
		// The run has begun once pi accepted it: a command right behind it must queue, not start another.
		if (disposition === "started") this.isStreaming = true;
		return disposition;
	}

	async steer(text: string): Promise<string> {
		const data = (await this.send({ type: "steer", message: text })) as { disposition?: string } | undefined;
		return String(data?.disposition ?? "queued");
	}

	async followUp(text: string): Promise<string> {
		const data = (await this.send({ type: "follow_up", message: text })) as { disposition?: string } | undefined;
		return String(data?.disposition ?? "queued");
	}

	async abort(): Promise<void> {
		await this.send({ type: "abort" });
	}

	async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
		const data = (await this.send({ type: "clear_queue" })) as { steering?: string[]; followUp?: string[] } | undefined;
		this.pendingMessageCount = 0;
		return { steering: data?.steering ?? [], followUp: data?.followUp ?? [] };
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** The process id of the box (bwrap, sandbox-exec's node, or node): for tests and diagnostics. */
	get pid(): number | undefined {
		return this.child.pid;
	}

	/**
	 * End the body: close its stdin (pi's orderly shutdown), then SIGTERM, then SIGKILL. bwrap's
	 * `--die-with-parent` and its pid namespace take every process of the box with it.
	 */
	async dispose(): Promise<void> {
		if (this.child.exitCode !== null || this.child.signalCode !== null) {
			await this.exited;
			return;
		}
		this.disposing = true;
		this.listeners.clear();
		this.child.stdin?.end();
		const waited = (ms: number) =>
			Promise.race([this.exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms).unref())]);
		if (await waited(EXIT_GRACE_MS)) return;
		this.child.kill("SIGTERM");
		if (await waited(EXIT_GRACE_MS)) return;
		this.child.kill("SIGKILL");
		await this.exited;
	}

	/** Kill the box at once (an abort the body does not honour). The exit is reported as a death. */
	kill(): void {
		this.child.kill("SIGKILL");
	}
}
