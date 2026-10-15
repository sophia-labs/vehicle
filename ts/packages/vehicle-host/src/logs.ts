/**
 * Append-only JSONL logs. Each line is one JSON object written with a single append; a torn last line (a
 * crash mid-write) is skipped on read, never repaired in place.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { MAX_WATCH_EVENTS } from "./protocol.ts";

export function appendJsonl(path: string, value: unknown): void {
	appendFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

export function readJsonl<T>(path: string): T[] {
	if (!existsSync(path)) return [];
	const rows: T[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (line.trim() === "") continue;
		try {
			rows.push(JSON.parse(line) as T);
		} catch {
			// A torn line: skipped.
		}
	}
	return rows;
}

export interface RideEvent {
	readonly seq: number;
	readonly ts: string;
	readonly type: string;
	readonly payload: Record<string, unknown>;
}

/** Live-only frames (text deltas): streamed to SSE subscribers, never logged, never given a cursor. */
export interface EphemeralEvent {
	readonly ephemeral: true;
	readonly ts: string;
	readonly type: string;
	readonly payload: Record<string, unknown>;
}

type Listener = (event: RideEvent | EphemeralEvent) => void;

/** The session's event log: a cursor (`seq`, from 1) over every durable event, with long-poll and push. */
export class EventLog {
	private readonly events: RideEvent[];
	private readonly listeners = new Set<Listener>();
	private path: string;
	private secrets: () => readonly string[] = () => [];

	constructor(path: string) {
		this.path = path;
		this.events = readJsonl<RideEvent>(path).sort((a, b) => a.seq - b.seq);
	}

	get cursor(): number {
		return this.events.at(-1)?.seq ?? 0;
	}

	/** Secrets no event may carry (a caller's own model key): replaced wherever they appear. */
	redact(secrets: () => readonly string[]): void {
		this.secrets = secrets;
	}

	private scrub(payload: Record<string, unknown>): Record<string, unknown> {
		const secrets = this.secrets().filter((secret) => secret.length >= 8);
		if (secrets.length === 0) return payload;
		let text = JSON.stringify(payload);
		if (!secrets.some((secret) => text.includes(secret))) return payload;
		for (const secret of secrets) text = text.split(secret).join("[redacted]");
		return JSON.parse(text) as Record<string, unknown>;
	}

	append(type: string, unscrubbed: Record<string, unknown> = {}): RideEvent {
		const payload = this.scrub(unscrubbed);
		const event: RideEvent = { seq: this.cursor + 1, ts: new Date().toISOString(), type, payload };
		appendJsonl(this.path, event);
		this.events.push(event);
		for (const listener of this.listeners) listener(event);
		return event;
	}

	/** The log's file moved (a deleted session's record, moved whole to the trash): append there from now on. */
	relocate(path: string): void {
		this.path = path;
	}

	ephemeral(type: string, payload: Record<string, unknown>): void {
		if (this.listeners.size === 0) return;
		const event: EphemeralEvent = { ephemeral: true, ts: new Date().toISOString(), type, payload: this.scrub(payload) };
		for (const listener of this.listeners) listener(event);
	}

	all(): readonly RideEvent[] {
		return this.events;
	}

	/** Events after `since`, at most `limit`. */
	since(since: number, limit = MAX_WATCH_EVENTS): RideEvent[] {
		const start = this.events.findIndex((event) => event.seq > since);
		return start < 0 ? [] : this.events.slice(start, start + limit);
	}

	/** Events after `since`; when there are none, wait up to `waitMs` for the next one. */
	async wait(since: number, waitMs: number, signal?: AbortSignal): Promise<RideEvent[]> {
		const ready = this.since(since);
		if (ready.length > 0 || waitMs <= 0) return ready;
		await new Promise<void>((resolve) => {
			const done = () => {
				clearTimeout(timer);
				this.listeners.delete(listener);
				signal?.removeEventListener("abort", done);
				resolve();
			};
			const listener: Listener = (event) => {
				if (!("ephemeral" in event) && event.seq > since) done();
			};
			const timer = setTimeout(done, waitMs);
			this.listeners.add(listener);
			signal?.addEventListener("abort", done, { once: true });
		});
		return this.since(since);
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}
