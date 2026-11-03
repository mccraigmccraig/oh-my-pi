import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type AgentTool, type AgentToolResult, TOOL_INTERRUPT_ABORT_REASON } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { emitSessionShutdownEvent, ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionAPI, ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession, discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WaitTool } from "@oh-my-pi/pi-coding-agent/tools/wait";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import type { CoordinationDetails } from "@oh-my-pi/pi-tui/tools/wait";

/**
 * Contract: a reply an extension expects for its agent (`pi.replies.expect`, a peer behind a
 * bridge) is one `wait` blocks for, in that session only, until a message interrupts the wait or
 * the expectation is released — by the extension or with the extension load.
 */
const PEER = "@murmur/leia";

type WaitResult = AgentToolResult<CoordinationDetails>;

/** An extension load on its own runtime, as one session's extensions get. */
async function loadBridge(): Promise<{ api: ExtensionAPI; runtime: ExtensionRuntime; runner: ExtensionRunner }> {
	const runtime = new ExtensionRuntime();
	let api: ExtensionAPI | undefined;
	const extension = await loadExtensionFromFactory(
		pi => {
			api = pi;
		},
		"/tmp",
		new EventBus(),
		runtime,
		"bridge",
	);
	if (!api) throw new Error("factory did not run");
	const runner = new ExtensionRunner([extension], runtime, "/tmp", { getCwd: () => "/tmp" } as never, {} as never);
	return { api, runtime, runner };
}

function waitTool(runtime: ExtensionRuntime, agentId = "Main"): WaitTool {
	return new WaitTool({
		cwd: process.cwd(),
		settings: Settings.isolated({ "launch.enabled": false }),
		agentRegistry: AgentRegistry.global(),
		asyncJobManager: new AsyncJobManager({}),
		getAgentId: () => agentId,
		expectedReplies: runtime.expectedReplies,
	} as unknown as ToolSession);
}

function text(result: WaitResult): string {
	const [first] = result.content;
	return first?.type === "text" ? first.text : "";
}

/** Whether `waiting` is still blocked once pending callbacks have run. */
async function stillBlocked(waiting: Promise<unknown>): Promise<boolean> {
	let settled = false;
	void waiting.then(() => {
		settled = true;
	});
	const tick = Promise.withResolvers<void>();
	setImmediate(tick.resolve);
	await tick.promise;
	return !settled;
}

/** The interrupt a steer injected by the bridge (or any message) raises on a running `wait`. */
async function interrupt(controller: AbortController, waiting: Promise<WaitResult>): Promise<WaitResult> {
	controller.abort(TOOL_INTERRUPT_ABORT_REASON);
	return waiting;
}

describe("wait on replies an extension expects", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});
	afterEach(() => {
		vi.useRealTimers();
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	test("blocks for an expected reply until a message interrupts it", async () => {
		const { api, runtime } = await loadBridge();
		api.replies.expect(PEER);
		const controller = new AbortController();
		const waiting = waitTool(runtime).execute("wait", {}, controller.signal);
		expect(await stillBlocked(waiting)).toBe(true);
		const result = await interrupt(controller, waiting);
		expect(text(result)).toBe("Wait interrupted by message.");
		expect(result.details).toMatchObject({ interrupted: true });
	});

	test("a release drops only its own expectation; with none left, wait is an idle poll again", async () => {
		const { api, runtime } = await loadBridge();
		const first = api.replies.expect(PEER);
		const second = api.replies.expect(PEER);
		first();
		first();
		const controller = new AbortController();
		const waiting = waitTool(runtime).execute("wait", {}, controller.signal);
		expect(await stillBlocked(waiting)).toBe(true);
		await interrupt(controller, waiting);

		second();
		const idle = await waitTool(runtime).execute("idle", {});
		expect(idle.useless).toBe(true);
		expect(text(idle)).toContain("Nothing to wait for");
	});

	test("releasing the last expectation ends a blocked wait, naming the peer", async () => {
		const { api, runtime } = await loadBridge();
		const release = api.replies.expect(PEER);
		const waiting = waitTool(runtime).execute("wait", {});
		expect(await stillBlocked(waiting)).toBe(true);
		release();
		const result = await waiting;
		expect(result.isError).toBeUndefined();
		expect(text(result)).toContain(`\`${PEER}\` no longer owes a reply`);
	});

	test("a wait that runs out names the peers still awaited", async () => {
		const { api, runtime } = await loadBridge();
		api.replies.expect(PEER);
		vi.useFakeTimers();
		const waiting = waitTool(runtime).execute("wait", {});
		vi.advanceTimersByTime(30 * 60_000);
		const result = await waiting;
		expect(text(result)).toBe(
			`Wait limit reached with no reply from \`${PEER}\`. Ask again, or finish without the answer.`,
		);
		expect(result.useless).toBe(true);
	});

	test("an unpromised expectation counts only in the run it was recorded in; a promised one outlives it", async () => {
		const { api, runtime } = await loadBridge();
		const run = { runStartedAt: 0, isStreaming: true };
		AgentRegistry.global().register({
			id: "Main",
			displayName: "Main",
			kind: "main",
			session: run as unknown as AgentSession,
			status: "running",
		});
		api.replies.expect(PEER);
		run.runStartedAt = Date.now() + 1;
		expect(text(await waitTool(runtime).execute("next-run", {}))).toContain("Nothing to wait for");

		api.replies.expect("@murmur/han", { promised: true });
		run.runStartedAt = Date.now() + 1;
		const controller = new AbortController();
		const waiting = waitTool(runtime).execute("later-run", {}, controller.signal);
		expect(await stillBlocked(waiting)).toBe(true);
		await interrupt(controller, waiting);
	});

	test("session shutdown releases the load's expectations", async () => {
		const { api, runtime, runner } = await loadBridge();
		api.replies.expect(PEER);
		await emitSessionShutdownEvent(runner);
		const result = await waitTool(runtime).execute("after-shutdown", {});
		expect(result.useless).toBe(true);
		expect(text(result)).toContain("Nothing to wait for");
	});

	test("a factory that expects a reply and then throws leaves no expectation behind", async () => {
		const runtime = new ExtensionRuntime();
		const failing: ExtensionFactory = pi => {
			pi.replies.expect(PEER);
			throw new Error("bridge failed to start");
		};
		await expect(loadExtensionFromFactory(failing, "/tmp", new EventBus(), runtime, "bridge")).rejects.toThrow(
			"bridge failed to start",
		);
		const result = await waitTool(runtime).execute("after-failed-load", {});
		expect(result.useless).toBe(true);
		expect(text(result)).toContain("Nothing to wait for");
	});

	describe("in real sessions", () => {
		let dir: string;
		let modelRegistry: ModelRegistry;

		beforeAll(async () => {
			dir = path.join(os.tmpdir(), `pi-wait-extension-replies-${Snowflake.next()}`);
			fs.mkdirSync(dir, { recursive: true });
			modelRegistry = new ModelRegistry(await discoverAuthStorage(dir));
		});
		afterAll(() => {
			modelRegistry.authStorage.close();
			removeSyncWithRetries(dir);
		});

		const open = async (extensions: ExtensionFactory[]): Promise<AgentSession> =>
			(
				await createAgentSession({
					cwd: dir,
					agentDir: dir,
					modelRegistry,
					// Same agent id in both sessions, each in its own registry.
					agentRegistry: new AgentRegistry(),
					sessionManager: SessionManager.inMemory(),
					settings: Settings.isolated(),
					model: getBundledModel("openai", "gpt-4o-mini"),
					disableExtensionDiscovery: true,
					extensions,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableMCP: false,
					enableLsp: false,
					rules: [],
					workspaceTree: { rootPath: dir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
				})
			).session;

		test("an expectation blocks only its own session's wait, though both agents are Main", async () => {
			let bridge: ExtensionAPI | undefined;
			const asker = await open([
				pi => {
					bridge = pi;
				},
			]);
			const bystander = await open([]);
			try {
				bridge?.replies.expect(PEER);
				const bystanderWait = bystander.getToolByName("wait") as AgentTool | undefined;
				const idle = (await bystanderWait?.execute("bystander", {})) as WaitResult;
				expect(text(idle)).toContain("Nothing to wait for");

				const askerWait = asker.getToolByName("wait") as AgentTool | undefined;
				const controller = new AbortController();
				const waiting = askerWait?.execute("asker", {}, controller.signal) as Promise<WaitResult>;
				expect(await stillBlocked(waiting)).toBe(true);
				expect(text(await interrupt(controller, waiting))).toBe("Wait interrupted by message.");
			} finally {
				await asker.dispose();
				await bystander.dispose();
			}
		});
	});
});
