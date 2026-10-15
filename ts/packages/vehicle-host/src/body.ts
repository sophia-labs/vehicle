/**
 * A session's body: the pi session that does the work, behind one small interface, so the ride's verbs and events
 * mean the same whatever the body is.
 *
 * - `InProcessBody` (profile `chat`): pi's SDK in the host's process. Its tools only reach the graph.
 * - `RpcBody` (profile `agent`, `./rpc-body.ts`): `pi --mode rpc`'s protocol over a child process, inside an
 *   isolation box (`./isolation.ts`), because its tools run code and write files.
 *
 * Both are mortal and rematerialized from pi's session file (principles 2 and 3 in the README): the record is the
 * host's, the body only works.
 */

import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export type BodyKind = "in-process" | "rpc";

export interface BodyStats {
	readonly tokens: unknown;
	readonly costUsd: number;
}

export interface PiBody {
	readonly kind: BodyKind;
	/** Where the body runs: `in-process`, or the isolation tier of an `rpc` body (`bwrap`, `seatbelt`, `none`). */
	readonly isolation: string;
	readonly sessionId: string;
	/** pi is in a run (an `rpc` body mirrors pi's state from its events and responses). */
	readonly isStreaming: boolean;
	/** Messages waiting in pi's steer and follow-up queues. */
	readonly pendingMessageCount: number;
	/** pi's session file, when the body knows it (an `rpc` body leaves it to the host to find, safely). */
	readonly sessionFile: string | undefined;
	activeToolNames(): string[];
	stats(): BodyStats | undefined;
	/** The active branch, when the body holds it in memory; `undefined`: read pi's file. */
	branch(): readonly Record<string, unknown>[] | undefined;
	/**
	 * Start a run with `text` (the body is idle): resolves with pi's disposition once pi accepted (`started`) or
	 * consumed (`handled`) it. A failure after acceptance is reported to `onRunError` (and in the events).
	 */
	prompt(text: string, onRunError: (message: string) => void): Promise<string>;
	steer(text: string): Promise<string>;
	followUp(text: string): Promise<string>;
	/** pi's abort: stops the run and waits until it is idle. */
	abort(): Promise<void>;
	/** Take every queued message back out of pi's queues. */
	clearQueue(): Promise<{ steering: string[]; followUp: string[] }>;
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	/** End the body. The session's record and pi's file stay; the next command rematerializes it. */
	dispose(): Promise<void>;
}

/** The `chat` body: pi's SDK session in this process (the first body, unchanged). */
export class InProcessBody implements PiBody {
	readonly kind = "in-process" as const;
	readonly isolation = "in-process";
	readonly session: AgentSession;

	constructor(session: AgentSession) {
		this.session = session;
	}

	get sessionId(): string {
		return this.session.sessionId;
	}

	get isStreaming(): boolean {
		return this.session.isStreaming;
	}

	get pendingMessageCount(): number {
		return this.session.pendingMessageCount;
	}

	get sessionFile(): string | undefined {
		return this.session.sessionFile;
	}

	activeToolNames(): string[] {
		return this.session.getActiveToolNames();
	}

	stats(): BodyStats {
		const stats = this.session.getSessionStats();
		return { tokens: stats.tokens, costUsd: stats.cost };
	}

	branch(): readonly Record<string, unknown>[] {
		return this.session.sessionManager.getBranch() as unknown as Record<string, unknown>[];
	}

	prompt(text: string, onRunError: (message: string) => void): Promise<string> {
		return new Promise((resolve, reject) => {
			let decided = false;
			this.session
				.prompt(text, {
					expandPromptTemplates: false,
					source: "rpc",
					preflightResult: (disposition) => {
						decided = true;
						resolve(disposition);
					},
				})
				.then(() => {
					if (!decided) resolve("handled");
				})
				.catch((error: unknown) => {
					if (!decided) {
						decided = true;
						reject(error);
					} else {
						onRunError(error instanceof Error ? error.message : String(error));
					}
				});
		});
	}

	steer(text: string): Promise<string> {
		return this.session.steer(text, undefined, { source: "rpc" });
	}

	followUp(text: string): Promise<string> {
		return this.session.followUp(text, undefined, { source: "rpc" });
	}

	abort(): Promise<void> {
		return this.session.abort();
	}

	async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
		return this.session.clearQueue();
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		return this.session.subscribe(listener);
	}

	async dispose(): Promise<void> {
		this.session.dispose();
	}
}
