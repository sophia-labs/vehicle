/**
 * The budget guard: at most `maxTurns` model turns and `maxCostUsd` dollars per run. A run is one pi agent
 * loop, from `agent_start` to `agent_end`: a prompt, the steering and follow-ups it absorbs, and its tool
 * turns. When a finished turn reaches a cap and the run would go on (the turn asked for tools, or messages
 * are queued), the guard aborts the run before its next model request and records why.
 *
 * Cost is the provider's reported cost; when a provider reports none, it is priced from the model's
 * catalogue price, so a cap holds for every provider pi knows.
 */

import { calculateCost } from "@earendil-works/pi-ai";

export interface SophiaBudget {
	/** Model turns per run. Default 12. */
	readonly maxTurns?: number;
	/** US dollars per run. Default 0.25. */
	readonly maxCostUsd?: number;
}

export const DEFAULT_BUDGET: Required<SophiaBudget> = Object.freeze({ maxTurns: 12, maxCostUsd: 0.25 });

export interface BudgetStop {
	readonly reason: "max_turns" | "max_cost";
	readonly turns: number;
	readonly costUsd: number;
	readonly limits: Required<SophiaBudget>;
}

export function normalizeBudget(budget: SophiaBudget | undefined): Required<SophiaBudget> {
	const maxTurns = budget?.maxTurns ?? DEFAULT_BUDGET.maxTurns;
	const maxCostUsd = budget?.maxCostUsd ?? DEFAULT_BUDGET.maxCostUsd;
	if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 1000) {
		throw new Error("budget.maxTurns must be an integer from 1 to 1000");
	}
	if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0 || maxCostUsd > 100) {
		throw new Error("budget.maxCostUsd must be a number above 0 and at most 100");
	}
	return { maxTurns, maxCostUsd };
}

interface UsageLike {
	readonly input?: number;
	readonly output?: number;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
	readonly totalTokens?: number;
	readonly cost?: { readonly total?: number };
}

/** The dollars one assistant message cost: reported, else priced from the model. */
export function messageCostUsd(usage: UsageLike | undefined, model: Parameters<typeof calculateCost>[0] | undefined): number {
	if (!usage) return 0;
	const reported = usage.cost?.total ?? 0;
	if (reported > 0 || !model) return reported;
	const priced = calculateCost(model, {
		input: usage.input ?? 0,
		output: usage.output ?? 0,
		cacheRead: usage.cacheRead ?? 0,
		cacheWrite: usage.cacheWrite ?? 0,
		totalTokens: usage.totalTokens ?? 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	});
	return priced.total;
}

export class BudgetGuard {
	readonly limits: Required<SophiaBudget>;
	private turns = 0;
	private costUsd = 0;
	private stopped: BudgetStop | undefined;

	constructor(budget: SophiaBudget | undefined) {
		this.limits = normalizeBudget(budget);
	}

	startRun(): void {
		this.turns = 0;
		this.costUsd = 0;
		this.stopped = undefined;
	}

	/** Count a finished turn. Returns the stop when this turn reached a cap. */
	endTurn(costUsd: number): BudgetStop | undefined {
		this.turns += 1;
		this.costUsd += costUsd;
		if (this.stopped) return undefined;
		const reason =
			this.costUsd >= this.limits.maxCostUsd ? "max_cost" : this.turns >= this.limits.maxTurns ? "max_turns" : undefined;
		if (!reason) return undefined;
		this.stopped = { reason, turns: this.turns, costUsd: this.costUsd, limits: this.limits };
		return this.stopped;
	}

	/** The stop of this run, once a cap was reached. */
	get exceeded(): BudgetStop | undefined {
		return this.stopped;
	}

	get spent(): { turns: number; costUsd: number } {
		return { turns: this.turns, costUsd: this.costUsd };
	}
}
