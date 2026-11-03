/**
 * Replies a session's agent awaits from peers its own tools cannot see, recorded by extensions
 * through `pi.replies.expect` (a bridge to agents in other processes). The `wait` tool counts them
 * as replies the caller is owed, alongside unanswered IRC questions.
 */

interface ExpectedReply {
	readonly peerId: string;
	readonly promised: boolean;
	/** Epoch ms the expectation was recorded; an unpromised one counts only in the run it was recorded in. */
	readonly since: number;
}

/**
 * One session's expected replies. Owned by the session's extension runtime, so expectations of
 * one session never reach another session's `wait`, whatever agent ids the two carry.
 */
export class ExpectedReplies {
	readonly #entries = new Set<ExpectedReply>();
	readonly #listeners = new Set<() => void>();

	/**
	 * Record that the agent awaits a reply from `peerId`. Each call is its own expectation; the
	 * returned function releases it and is idempotent.
	 */
	expect(peerId: string, options?: { promised?: boolean }): () => void {
		const entry: ExpectedReply = { peerId, promised: options?.promised === true, since: Date.now() };
		this.#entries.add(entry);
		this.#notify();
		return () => {
			if (this.#entries.delete(entry)) this.#notify();
		};
	}

	/**
	 * Peers still awaited, each once, by a run that started at `runStartedAt` (0 when unknown):
	 * an unpromised expectation recorded before the run started owes the run nothing.
	 */
	pending(runStartedAt: number): string[] {
		const peers = new Set<string>();
		for (const entry of this.#entries) {
			if (entry.promised || entry.since >= runStartedAt) peers.add(entry.peerId);
		}
		return [...peers];
	}

	/** Subscribe to expectations being added or released; returns the unsubscribe function. */
	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	#notify(): void {
		for (const listener of this.#listeners) listener();
	}
}
