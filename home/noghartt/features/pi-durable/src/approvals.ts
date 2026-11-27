import type { Context } from "@earendil-works/chord/context";

export interface ApprovalRequest {
	readonly title: string;
	readonly message: string;
}

/** Shows a request and settles with the answer; resolves false when `signal` aborts first. */
export type Approver = (request: ApprovalRequest, signal: AbortSignal | undefined) => Promise<boolean>;

/**
 * Durable tools get no UI, so a tool that must ask the user goes through this bridge: the TUI registers the dialog once
 * it is up. Without one (before the TUI starts, or after it stops) every request is refused.
 */
export class Approvals {
	#approver: Approver | undefined;

	/** Register the dialog; returns its removal. */
	handle(approver: Approver): () => void {
		this.#approver = approver;
		return () => {
			if (this.#approver === approver) this.#approver = undefined;
		};
	}

	get available(): boolean {
		return this.#approver !== undefined;
	}

	request(request: ApprovalRequest, context: Context): Promise<boolean> {
		if (this.#approver === undefined || context.abortSignal?.aborted) return Promise.resolve(false);
		return this.#approver(request, context.abortSignal);
	}
}
