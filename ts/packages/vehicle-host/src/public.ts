/**
 * Public sessions: people and agents with no Sophia login of this gardend, on a gardend in public mode
 * (garden `docs/local-service-hosting.md`, "Public mode"). gardend mints them as viewers of the public graphs:
 * `x-sophia-caller-kind: anonymous` (`anon:<hash>`) or `account` (`cognito:<sub>`, a Sophia account, with
 * `x-sophia-account-email-verified`).
 *
 * They read for free (gardend's own surface). A conversation with an agent costs model money, so it opens by one
 * of two doors (2026-10-14):
 *
 * 1. **Their own key** (`X-Model-Key`, an OpenRouter key, sent with every request; gardend forwards it only to a
 *    service whose manifest says `"acceptsModelKey": true`). The session's body uses it as its provider key. It is
 *    held in memory for that session only: never in a file, an event, the capsule, the mirror or pi's file. After a
 *    restart the next request brings it again. Any model of the provider.
 * 2. **A Sophia account with credit.** A verified email gets the signup grant once (`signupGrantUsd`); each run is
 *    debited by its real cost (pi's usage: the provider-reported cost). The house key pays, on a short list of cheap
 *    models. At zero: "out of credit: paste your OpenRouter key". A global daily cap on credit-funded spend
 *    (`creditDailyCapUsd`) guards against signup abuse.
 *
 * Both doors share the abuse limits: turns per principal per day, turns per conversation, and a per-run budget.
 *
 * The ledger (`$DATA_DIR/public/ledger.jsonl`) is append-only. A row is a `grant` (credit in: `source` signup |
 * purchase | operator), a `debit` (credit spent by a run) or a `turn` (any public turn, counted for the limits).
 * Every grant and debit carries an idempotency key, so a payment that is delivered twice credits once.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SophiaBudget } from "@sophia-labs/pi-sophia";
import { appendJsonl, readJsonl } from "./logs.ts";
import { type Caller, RideError } from "./protocol.ts";

export type Funding = "byok" | "credit";
export type GrantSource = "signup" | "purchase" | "operator";

export interface PublicSettings {
	/** The provider a caller's own key is for (`VEHICLE_PUBLIC_PROVIDER`, default `openrouter`). */
	readonly provider: string;
	/** A caller's own key, with no model named (`VEHICLE_PUBLIC_DEFAULT_MODEL`). */
	readonly byokDefaultModel: string;
	/** A credit session, with no model named (`VEHICLE_CREDIT_DEFAULT_MODEL`). */
	readonly creditDefaultModel: string;
	/** The models credit pays for (`VEHICLE_CREDIT_MODELS`, a comma list of `provider/model`). */
	readonly creditModels: readonly string[];
	/** Credit a verified account gets once (`VEHICLE_SIGNUP_GRANT_USD`, default 0.50). */
	readonly signupGrantUsd: number;
	/** Credit-funded spend per UTC day, everyone together (`VEHICLE_CREDIT_DAILY_CAP_USD`, default 5). */
	readonly creditDailyCapUsd: number;
	/** Turns per public principal per UTC day, either door (`VEHICLE_PUBLIC_TURNS_PER_DAY`, default 100). */
	readonly turnsPerDay: number;
	/** Turns per public conversation (`VEHICLE_PUBLIC_SESSION_MAX_TURNS`, default 40). */
	readonly sessionMaxTurns: number;
	/** The budget of each run of a public session (`VEHICLE_PUBLIC_RUN_MAX_TURNS`, `VEHICLE_PUBLIC_RUN_MAX_COST_USD`). */
	readonly runBudget: Required<SophiaBudget>;
}

export const DEFAULT_PUBLIC_SETTINGS: PublicSettings = Object.freeze({
	provider: "openrouter",
	byokDefaultModel: "openrouter/openai/gpt-6-luna",
	creditDefaultModel: "openrouter/deepseek/deepseek-v4.1-flash",
	creditModels: Object.freeze([
		"openrouter/deepseek/deepseek-v4.1-flash",
		"openrouter/deepseek/deepseek-v4-flash",
		"openrouter/openai/gpt-6-luna",
		"openrouter/google/gemini-2.5-flash",
		"openrouter/qwen/qwen3-235b-a22b-2507",
	]),
	signupGrantUsd: 0.5,
	creditDailyCapUsd: 5,
	turnsPerDay: 100,
	sessionMaxTurns: 40,
	runBudget: Object.freeze({ maxTurns: 8, maxCostUsd: 0.05 }),
});

/** What the refusals point to: the two doors. */
export const DOORS = Object.freeze({
	byok: { header: "X-Model-Key", what: "your own OpenRouter key, sent with every request (https://openrouter.ai/keys)" },
	account: { header: "Authorization: Bearer <Sophia account ID token>", what: "a Sophia account: $0.50 of credit to start" },
});

const NO_DOOR =
	"To talk to an agent here, paste your OpenRouter key (send it as X-Model-Key with every request) or sign in with a Sophia account ($0.50 of credit to start). Reading the data needs neither.";
const OUT_OF_CREDIT = "out of credit: paste your OpenRouter key (send it as X-Model-Key) to keep talking";
const POOL_EXHAUSTED =
	"Today's credit for everyone is used up. Paste your OpenRouter key (X-Model-Key) to keep talking now, or come back tomorrow (UTC).";

interface LedgerRow {
	readonly id: string;
	readonly ts: string;
	/** The UTC day, `YYYY-MM-DD`. */
	readonly day: string;
	readonly kind: "grant" | "debit" | "turn";
	readonly principal: string;
	readonly amountUsd?: number;
	readonly source?: GrantSource;
	readonly idempotencyKey?: string;
	readonly sessionId?: string;
	readonly runId?: string;
	readonly model?: string;
	readonly funding?: Funding;
	readonly note?: string;
}

const day = (date = new Date()): string => date.toISOString().slice(0, 10);
const cents = (usd: number): number => Math.round(usd * 1e6) / 1e6;

export function isPublicCaller(caller: Caller): boolean {
	return caller.kind === "anonymous" || caller.kind === "account";
}

/** The append-only ledger and the gates every public session passes. */
export class PublicPolicy {
	readonly settings: PublicSettings;
	private readonly path: string;
	private readonly keys = new Set<string>();
	private readonly balances = new Map<string, { granted: number; spent: number }>();
	private readonly turns = new Map<string, number>();
	private spentToday = { day: day(), usd: 0 };
	private turnsDay = day();

	constructor(dataDir: string, settings: PublicSettings = DEFAULT_PUBLIC_SETTINGS) {
		this.settings = settings;
		const dir = join(dataDir, "public");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		this.path = join(dir, "ledger.jsonl");
		for (const row of readJsonl<LedgerRow>(this.path)) this.apply(row);
	}

	private apply(row: LedgerRow): void {
		if (row.idempotencyKey) this.keys.add(row.idempotencyKey);
		const today = day();
		if (row.kind === "turn") {
			if (row.day === today) this.turns.set(row.principal, (this.turns.get(row.principal) ?? 0) + 1);
			return;
		}
		const balance = this.balances.get(row.principal) ?? { granted: 0, spent: 0 };
		if (row.kind === "grant") balance.granted = cents(balance.granted + (row.amountUsd ?? 0));
		if (row.kind === "debit") {
			balance.spent = cents(balance.spent + (row.amountUsd ?? 0));
			if (row.day === today) {
				if (this.spentToday.day !== today) this.spentToday = { day: today, usd: 0 };
				this.spentToday.usd = cents(this.spentToday.usd + (row.amountUsd ?? 0));
			}
		}
		this.balances.set(row.principal, balance);
	}

	private append(row: Omit<LedgerRow, "id" | "ts" | "day">): boolean {
		if (row.idempotencyKey && this.keys.has(row.idempotencyKey)) return false;
		const now = new Date();
		const full: LedgerRow = { id: randomUUID(), ts: now.toISOString(), day: day(now), ...row };
		appendJsonl(this.path, full);
		this.rollDay();
		this.apply(full);
		return true;
	}

	private rollDay(): void {
		const today = day();
		if (this.turnsDay !== today) {
			this.turns.clear();
			this.turnsDay = today;
		}
		if (this.spentToday.day !== today) this.spentToday = { day: today, usd: 0 };
	}

	balanceOf(principal: string): number {
		const balance = this.balances.get(principal);
		return balance ? cents(balance.granted - balance.spent) : 0;
	}

	turnsToday(principal: string): number {
		this.rollDay();
		return this.turns.get(principal) ?? 0;
	}

	creditSpentToday(): number {
		this.rollDay();
		return this.spentToday.usd;
	}

	/** A verified account's signup credit, once per account (the first time it is seen). */
	grantSignup(caller: Caller): void {
		if (caller.kind !== "account" || caller.emailVerified !== true || this.settings.signupGrantUsd <= 0) return;
		this.append({
			kind: "grant",
			principal: caller.principal,
			amountUsd: this.settings.signupGrantUsd,
			source: "signup",
			idempotencyKey: `signup:${caller.principal}`,
		});
	}

	/** Credit from elsewhere (a purchase, the operator): idempotent by its key. True when it was new. */
	grant(principal: string, amountUsd: number, source: GrantSource, idempotencyKey: string, note?: string): boolean {
		if (!/^(cognito|anon):[A-Za-z0-9-]{1,128}$/.test(principal)) throw new RideError("invalid_request", 400, "principal must be cognito:<sub>");
		if (!Number.isFinite(amountUsd) || amountUsd <= 0 || amountUsd > 1000) throw new RideError("invalid_request", 400, "amountUsd must be above 0 and at most 1000");
		if (!["signup", "purchase", "operator"].includes(source)) throw new RideError("invalid_request", 400, "source must be signup, purchase or operator");
		if (!/^[A-Za-z0-9:_.-]{1,200}$/.test(idempotencyKey)) throw new RideError("invalid_request", 400, "idempotencyKey must be 1-200 of [A-Za-z0-9:_.-]");
		return this.append({ kind: "grant", principal, amountUsd: cents(amountUsd), source, idempotencyKey: `${source}:${idempotencyKey}`, ...(note ? { note: note.slice(0, 200) } : {}) });
	}

	/**
	 * Which door a new public session opens by, and its model: its own key when it brought one, else an account's
	 * credit; an anonymous caller without a key is refused with the two doors.
	 */
	open(caller: Caller, hasModelKey: boolean, requestedModel: unknown): { funding: Funding; model: string } {
		if (hasModelKey) {
			const model = requestedModel === undefined ? this.settings.byokDefaultModel : String(requestedModel);
			if (!model.startsWith(`${this.settings.provider}/`)) {
				throw new RideError("model_not_allowed", 400, `your key is a ${this.settings.provider} key: name a ${this.settings.provider}/... model`);
			}
			return { funding: "byok", model };
		}
		if (caller.kind !== "account") throw new RideError("model_key_required", 402, NO_DOOR, { doors: DOORS });
		this.grantSignup(caller);
		const model = requestedModel === undefined ? this.settings.creditDefaultModel : String(requestedModel);
		if (!this.settings.creditModels.includes(model)) {
			throw new RideError("model_not_allowed", 400, `credit pays for these models: ${this.settings.creditModels.join(", ")}; with your own key (X-Model-Key) any ${this.settings.provider} model`, {
				creditModels: this.settings.creditModels,
			});
		}
		this.requireCredit(caller);
		return { funding: "credit", model };
	}

	private requireCredit(caller: Caller): void {
		if (caller.kind === "account" && caller.emailVerified !== true && this.balanceOf(caller.principal) <= 0) {
			throw new RideError("email_unverified", 402, "verify your account's email to get its credit, or paste your OpenRouter key (X-Model-Key)", { doors: DOORS });
		}
		if (this.balanceOf(caller.principal) <= 0) throw new RideError("out_of_credit", 402, OUT_OF_CREDIT, { balanceUsd: this.balanceOf(caller.principal), doors: DOORS });
		if (this.creditSpentToday() >= this.settings.creditDailyCapUsd) {
			throw new RideError("credit_pool_exhausted", 503, POOL_EXHAUSTED, { capUsd: this.settings.creditDailyCapUsd, doors: DOORS });
		}
	}

	/**
	 * Before a public turn (a prompt, follow-up or steer is accepted): the limits, then the door's own condition. The
	 * turn is counted once it passes.
	 */
	beforeTurn(caller: Caller, session: { sessionId: string; funding: Funding | undefined; turnsTaken: number }, hasModelKey: boolean): void {
		if (session.turnsTaken >= this.settings.sessionMaxTurns) {
			throw new RideError("session_turn_limit", 429, `This conversation has reached its ${this.settings.sessionMaxTurns} turns. Start a new one to keep going.`);
		}
		if (this.turnsToday(caller.principal) >= this.settings.turnsPerDay) {
			throw new RideError("daily_turn_limit", 429, `You have used today's ${this.settings.turnsPerDay} turns. Come back tomorrow (UTC).`);
		}
		if (session.funding === "byok" && !hasModelKey) {
			throw new RideError(
				"model_key_required",
				402,
				"This conversation runs on your own OpenRouter key: send it as X-Model-Key with every request (it is never stored here, so it is needed again after a restart).",
				{ doors: DOORS },
			);
		}
		if (session.funding === "credit") this.requireCredit(caller);
		this.append({ kind: "turn", principal: caller.principal, sessionId: session.sessionId, funding: session.funding ?? "byok" });
	}

	/** After a credit-funded run settles: its real cost, once per run. */
	debit(principal: string, sessionId: string, runId: string, costUsd: number, model: string): void {
		if (!(costUsd > 0)) return;
		this.append({ kind: "debit", principal, amountUsd: cents(costUsd), sessionId, runId, model, idempotencyKey: `run:${sessionId}:${runId}` });
	}

	/** `GET /account`: what the caller has, and how to talk to an agent. */
	account(caller: Caller): Record<string, unknown> {
		const base = {
			principal: caller.principal,
			turnsToday: this.turnsToday(caller.principal),
			turnsPerDay: this.settings.turnsPerDay,
			sessionMaxTurns: this.settings.sessionMaxTurns,
			doors: DOORS,
			byok: { provider: this.settings.provider, defaultModel: this.settings.byokDefaultModel },
		};
		if (caller.kind !== "account") return { kind: "anonymous", ...base };
		this.grantSignup(caller);
		const balance = this.balances.get(caller.principal) ?? { granted: 0, spent: 0 };
		return {
			kind: "account",
			...base,
			...(caller.email ? { email: caller.email } : {}),
			emailVerified: caller.emailVerified === true,
			credit: {
				balanceUsd: this.balanceOf(caller.principal),
				grantedUsd: balance.granted,
				spentUsd: balance.spent,
				defaultModel: this.settings.creditDefaultModel,
				models: this.settings.creditModels,
				poolOpenToday: this.creditSpentToday() < this.settings.creditDailyCapUsd,
			},
		};
	}
}

function numberEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
	const raw = env[name]?.trim();
	if (!raw) return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a number of at least 0`);
	return value;
}

/** The public settings from the environment (`gardend service env set ... --service vehicle`). */
export function publicSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): PublicSettings {
	const d = DEFAULT_PUBLIC_SETTINGS;
	const list = env.VEHICLE_CREDIT_MODELS?.split(",").map((model) => model.trim()).filter(Boolean);
	const creditDefaultModel = env.VEHICLE_CREDIT_DEFAULT_MODEL?.trim() || d.creditDefaultModel;
	const creditModels = list && list.length > 0 ? list : d.creditModels;
	if (!creditModels.includes(creditDefaultModel)) throw new Error("VEHICLE_CREDIT_DEFAULT_MODEL must be one of VEHICLE_CREDIT_MODELS");
	const maxTurns = numberEnv(env, "VEHICLE_PUBLIC_RUN_MAX_TURNS", d.runBudget.maxTurns);
	const maxCostUsd = numberEnv(env, "VEHICLE_PUBLIC_RUN_MAX_COST_USD", d.runBudget.maxCostUsd);
	return {
		provider: env.VEHICLE_PUBLIC_PROVIDER?.trim() || d.provider,
		byokDefaultModel: env.VEHICLE_PUBLIC_DEFAULT_MODEL?.trim() || d.byokDefaultModel,
		creditDefaultModel,
		creditModels,
		signupGrantUsd: numberEnv(env, "VEHICLE_SIGNUP_GRANT_USD", d.signupGrantUsd),
		creditDailyCapUsd: numberEnv(env, "VEHICLE_CREDIT_DAILY_CAP_USD", d.creditDailyCapUsd),
		turnsPerDay: numberEnv(env, "VEHICLE_PUBLIC_TURNS_PER_DAY", d.turnsPerDay),
		sessionMaxTurns: numberEnv(env, "VEHICLE_PUBLIC_SESSION_MAX_TURNS", d.sessionMaxTurns),
		runBudget: { maxTurns, maxCostUsd },
	};
}
