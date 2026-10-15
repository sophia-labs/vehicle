/**
 * The session capsule: a bounded, read-only projection that is safe to carry across a handoff (a person
 * passing a ride to an agent, or one agent to another). It carries identity, posture, a command summary,
 * recent milestones and the assistant's recent answers. It never carries a secret, the system prompt, the
 * text of a command or chime (prompt bodies), tool arguments or tool results, or any mutation authority.
 */

import { accessForRole } from "@sophia-labs/pi-sophia";
import { bounded, CAPSULE_SCHEMA } from "./protocol.ts";
import type { RideSession } from "./session.ts";

export const MAX_CAPSULE_MILESTONES = 128;
export const MAX_CAPSULE_TRANSCRIPT_ITEMS = 32;
export const MAX_CAPSULE_TEXT_BYTES = 4 * 1024;

const MILESTONES: ReadonlySet<string> = new Set([
	"session.created",
	"session.revived",
	"session.shutdown",
	"body.materialized",
	"body.dormant",
	"lease.claimed",
	"lease.released",
	"lease.revoked",
	"lease.expired",
	"command.accepted",
	"command.delivered",
	"command.completed",
	"command.aborted",
	"command.failed",
	"command.cancelled",
	"command.interrupted",
	"run.started",
	"run.settled",
	"budget.exceeded",
	"room.policy",
	"chime.resolved",
]);

/** Payload keys a milestone may carry: identifiers, statuses and counts, never text. */
const SAFE_KEYS = ["commandId", "op", "runId", "aborted", "stopReason", "reason", "status", "policy", "chimeId", "clientId", "chars", "interrupted", "turns", "costUsd", "piSessionId", "resumedFromFile"];

export function buildCapsule(session: RideSession): Record<string, unknown> {
	const events = session.events.all().filter((event) => MILESTONES.has(event.type));
	const omittedMilestones = Math.max(0, events.length - MAX_CAPSULE_MILESTONES);
	const milestones = events.slice(omittedMilestones).map((event) => ({
		seq: event.seq,
		ts: event.ts,
		type: event.type,
		payload: Object.fromEntries(SAFE_KEYS.filter((key) => key in event.payload).map((key) => [key, event.payload[key]])),
	}));

	const transcriptAll = session.branchEntries().flatMap((entry): Record<string, unknown>[] => {
		if (entry.type !== "message") return [];
		const message = entry.message as { role: string; content?: unknown; stopReason?: string; toolName?: string; isError?: boolean; usage?: { totalTokens?: number } };
		const blocks = Array.isArray(message.content) ? (message.content as { type?: string; text?: string; name?: string }[]) : [];
		if (message.role === "assistant") {
			const text = blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
			const tools = blocks.filter((block) => block.type === "toolCall").map((block) => block.name);
			return [
				{
					entryId: entry.id,
					role: "assistant",
					text: bounded(text, MAX_CAPSULE_TEXT_BYTES),
					...(tools.length > 0 ? { toolCalls: tools } : {}),
					stopReason: message.stopReason,
					...(message.usage?.totalTokens ? { tokens: message.usage.totalTokens } : {}),
				},
			];
		}
		if (message.role === "user") {
			const content = message.content;
			const chars = typeof content === "string" ? [...content].length : blocks.reduce((sum, block) => sum + [...(block.text ?? "")].length, 0);
			return [{ entryId: entry.id, role: "user", chars }];
		}
		if (message.role === "toolResult") return [{ entryId: entry.id, role: "toolResult", toolName: message.toolName, isError: message.isError === true }];
		return [];
	});
	const omittedTranscriptItems = Math.max(0, transcriptAll.length - MAX_CAPSULE_TRANSCRIPT_ITEMS);

	const counts: Record<string, number> = {};
	for (const record of session.commands.values()) counts[record.status] = (counts[record.status] ?? 0) + 1;
	const recent = [...session.commands.values()].slice(-16).map((record) => ({
		commandId: record.commandId,
		op: record.op,
		status: record.status,
		acceptedAt: record.acceptedAt,
		...(record.settledAt ? { settledAt: record.settledAt } : {}),
		...(record.via ? { via: { author: record.via.author } } : {}),
	}));

	return {
		schema: CAPSULE_SCHEMA,
		sessionId: session.meta.sessionId,
		graphId: session.meta.graphId,
		profile: session.meta.profile,
		...(session.meta.profile === "agent" ? { isolation: session.summary().isolation } : {}),
		access: accessForRole(session.meta.role),
		model: `${session.meta.model.provider}/${session.meta.model.id}`,
		...(session.meta.parent ? { parent: session.meta.parent } : {}),
		status: session.status,
		cursor: session.events.cursor,
		lease: session.leaseView(),
		budget: session.meta.budget,
		commandSummary: { counts, recent },
		milestones,
		omittedMilestones,
		transcript: transcriptAll.slice(omittedTranscriptItems),
		omittedTranscriptItems,
		authority: { mode: "read-only-projection", mutations: false },
	};
}
