/**
 * The reference URL-scheme bridge (examples/extensions/url-scheme-bridge) exercised the way an
 * embedder uses it: loaded as an extension into createAgentSession, connecting on `session_start`,
 * speaking the JSON-lines protocol to an in-process stand-in for `peer-cli.ts`.
 *
 * Contracts: `read <ns>://` lists the roster and completion offers the peers; `write <ns>://<peer>`
 * reaches the peer as one intact record and the peer's ack is the write result; a written message
 * makes `wait` block for the peer's answer; an inbound line is injected into the session as a
 * steered message and releases that expectation; a dropped peer fails a write in flight.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession, type WorkspaceTree } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake, TempDir } from "@oh-my-pi/pi-utils";
import urlSchemeBridge from "../../examples/extensions/url-scheme-bridge/extension";
import {
	type BridgeMessage,
	encodeLine,
	LineDecoder,
	LineWriter,
	type PeerMessage,
	type Roster,
} from "../../examples/extensions/url-scheme-bridge/protocol";

const emptyWorkspaceTree = (cwd: string): WorkspaceTree => ({
	rootPath: cwd,
	rendered: ".",
	truncated: false,
	totalLines: 1,
	agentsMdFiles: [],
});

/** In-process stand-in for peer-cli.ts: listens, records bridge lines, lets the test answer. */
function startPeer(socketPath: string): {
	next: <T extends BridgeMessage["type"]>(type: T) => Promise<Extract<BridgeMessage, { type: T }>>;
	send: (message: PeerMessage) => void;
	stop: () => void;
} {
	const received: BridgeMessage[] = [];
	const waiters: Array<{ type: BridgeMessage["type"]; resolve: (message: BridgeMessage) => void }> = [];
	let bridge: Bun.Socket | undefined;
	let stopped = false;
	const decoder = new LineDecoder<BridgeMessage>((line, error) => {
		throw new Error(`peer: malformed bridge line ${line}: ${String(error)}`);
	});
	const deliver = (message: BridgeMessage): void => {
		const index = waiters.findIndex(waiter => waiter.type === message.type);
		if (index === -1) {
			received.push(message);
			return;
		}
		const [waiter] = waiters.splice(index, 1);
		waiter.resolve(message);
	};
	const server = Bun.listen({
		unix: socketPath,
		socket: {
			open(socket) {
				bridge = socket;
			},
			data(_socket, chunk) {
				for (const message of decoder.push(chunk)) deliver(message);
			},
			close() {
				bridge = undefined;
			},
			error() {},
		},
	});
	return {
		next: <T extends BridgeMessage["type"]>(type: T) => {
			const { promise, resolve } = Promise.withResolvers<Extract<BridgeMessage, { type: T }>>();
			const matches = (message: BridgeMessage): message is Extract<BridgeMessage, { type: T }> =>
				message.type === type;
			const index = received.findIndex(matches);
			if (index !== -1) {
				const [message] = received.splice(index, 1);
				if (matches(message)) resolve(message);
			} else {
				waiters.push({
					type,
					resolve: message => {
						if (matches(message)) resolve(message);
					},
				});
			}
			return promise;
		},
		send: message => {
			if (!bridge) throw new Error("peer: bridge not connected");
			bridge.write(encodeLine(message));
		},
		stop: () => {
			if (stopped) return;
			stopped = true;
			bridge?.end();
			server.stop(true);
		},
	};
}

describe("examples/extensions/url-scheme-bridge", () => {
	const tempDirs: TempDir[] = [];
	const savedRoster = Bun.env.OMP_PEER_BRIDGE_ROSTER;

	beforeEach(() => {
		InternalUrlRouter.resetForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		InternalUrlRouter.resetForTests();
		if (savedRoster === undefined) delete Bun.env.OMP_PEER_BRIDGE_ROSTER;
		else Bun.env.OMP_PEER_BRIDGE_ROSTER = savedRoster;
		for (const dir of tempDirs.splice(0)) await dir.remove().catch(() => {});
	});

	it("serves the roster, sends writes to the peer, injects its messages, and lets wait block for them", async () => {
		const tempDir = TempDir.createSync(`@pi-url-scheme-bridge-${Snowflake.next()}-`);
		tempDirs.push(tempDir);
		const cwd = tempDir.join("project");
		fs.mkdirSync(cwd, { recursive: true });
		const agentDir = tempDir.join("agent");
		fs.mkdirSync(agentDir, { recursive: true });
		// Unix socket paths are length-capped (104 bytes on macOS); keep it in /tmp.
		const socketPath = `/tmp/omp-usb-${Snowflake.next()}.sock`;
		const roster: Roster = { namespace: "demo", socket: socketPath, peers: ["leia", "han"] };
		const rosterPath = tempDir.join("roster.json");
		fs.writeFileSync(rosterPath, JSON.stringify(roster));
		Bun.env.OMP_PEER_BRIDGE_ROSTER = rosterPath;

		const peer = startPeer(socketPath);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			sessionManager: SessionManager.inMemory(cwd),
			settings: Settings.isolated(),
			model,
			disableExtensionDiscovery: true,
			extensions: [urlSchemeBridge],
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			workspaceTree: emptyWorkspaceTree(cwd),
			agentRegistry: new AgentRegistry(),
		});
		const router = InternalUrlRouter.instance();
		try {
			// session_start is where the bridge registers its scheme and connects.
			await initializeExtensions(session, {
				mode: "print",
				reportSendError: (_action, error) => {
					throw error;
				},
				reportRuntimeError: error => {
					throw new Error(`extension error: ${error.error}`);
				},
			});
			expect(await peer.next("hello")).toEqual({ type: "hello", agentId: "Main", namespace: "demo" });

			// read demo:// lists the roster; completion offers the peers.
			const listing = await router.resolve("demo://");
			expect(listing.content).toContain("demo://leia");
			expect(listing.content).toContain("demo://han");
			expect((await router.complete("demo", ""))?.map(candidate => candidate.value)).toEqual(["leia", "han"]);

			// write demo://leia: one line to the peer, whose ack is the write result.
			const writing = router.write("demo://leia", "hi leia");
			const outbound = await peer.next("outbound");
			expect(outbound).toMatchObject({ from: "Main", to: "leia", body: "hi leia", expectsReply: true });
			peer.send({ type: "ack", id: outbound.id, receipt: { outcome: "delivered" } });
			const result = await writing;
			expect(result?.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("@demo/leia") });

			// The written message expects an answer, so wait blocks for leia instead of reporting
			// "Nothing to wait for"; the wait is cut short here the way an interrupt would.
			const waitTool = session.getToolByName("wait");
			if (!waitTool) throw new Error("expected the wait tool");
			const waitAbort = new AbortController();
			const waiting = waitTool.execute("wait-1", {}, waitAbort.signal);
			const early = await Promise.race([waiting.then(() => "returned"), Bun.sleep(300).then(() => "blocked")]);
			expect(early).toBe("blocked");
			waitAbort.abort();
			await waiting.catch(() => undefined);

			// A body far larger than one socket write still arrives as one intact record.
			const bigBody = "x".repeat(4 * 1024 * 1024);
			const writingBig = router.write("demo://han?notify", bigBody);
			const big = await peer.next("outbound");
			expect(big.to).toBe("han");
			expect(big.expectsReply).toBe(false);
			expect(big.body.length).toBe(bigBody.length);
			peer.send({ type: "ack", id: big.id, receipt: { outcome: "delivered" } });
			await writingBig;

			// Inbound: the peer's line becomes a steered custom message; the receipt goes back on the wire.
			const injected = vi.spyOn(session, "sendCustomMessage").mockResolvedValue(true);
			peer.send({ type: "inbound", id: "peer-1", from: "leia", body: "pong", expectsReply: true });
			expect(await peer.next("receipt")).toEqual({
				type: "receipt",
				id: "peer-1",
				receipt: { outcome: "delivered" },
			});
			expect(injected).toHaveBeenCalledTimes(1);
			const [payload, options] = injected.mock.calls[0];
			expect(payload).toMatchObject({
				customType: "url-scheme-bridge",
				content: expect.stringContaining("[@demo/leia]"),
				details: { from: "@demo/leia", expectsReply: true },
			});
			expect(options).toMatchObject({ deliverAs: "steer", triggerTurn: true });

			// A write in flight when the peer drops fails, naming the peer.
			const stranded = router.write("demo://han", "anyone there");
			await peer.next("outbound");
			peer.stop();
			await expect(stranded).rejects.toThrow(/@demo\/han.*disconnected/);
		} finally {
			await session.dispose();
			peer.stop();
			fs.rmSync(socketPath, { force: true });
		}
		// The scheme went with the session.
		expect(router.canHandle("demo://leia")).toBe(false);
	});
});

describe("url-scheme-bridge LineDecoder", () => {
	it("reassembles a UTF-8 character split across socket chunks", () => {
		const decoder = new LineDecoder<{ body: string }>((line, error) => {
			throw new Error(`malformed ${line}: ${String(error)}`);
		});
		const bytes = new TextEncoder().encode('{"body":"héllo €"}\n');
		// Cut inside the two-byte "é" (C3 A9): a per-chunk decode would yield replacement characters.
		expect(decoder.push(bytes.slice(0, 11))).toEqual([]);
		expect(decoder.push(bytes.slice(11))).toEqual([{ body: "héllo €" }]);
	});
});

describe("url-scheme-bridge LineWriter", () => {
	it("retains the unwritten suffix of a long record and completes it on drain, in order", () => {
		const chunks: Uint8Array[] = [];
		const socket = {
			write(data: Uint8Array) {
				const accepted = data.subarray(0, Math.min(10, data.byteLength));
				chunks.push(accepted);
				return accepted.byteLength;
			},
		} as unknown as Bun.Socket;
		const written = () => new TextDecoder().decode(Buffer.concat(chunks));
		const writer = new LineWriter();
		writer.attach(socket);
		const first: PeerMessage = { type: "inbound", id: "p1", from: "leia", body: "a".repeat(50), expectsReply: false };
		const second: PeerMessage = { type: "ack", id: "m2", receipt: { outcome: "delivered" } };
		writer.write(first);
		writer.write(second);
		for (let i = 0; i < 20; i++) writer.flush();
		expect(written()).toBe(encodeLine(first) + encodeLine(second));
	});
});
