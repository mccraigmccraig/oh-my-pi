/**
 * URL-scheme bridge (reference implementation).
 *
 * Connects an omp session to agents in other processes using only the public extension API:
 *
 * - `pi.registerUrlScheme(handler)` — serves `<namespace>://`. `read <namespace>://` lists the
 *   peers, `read <namespace>://<peer>` describes one, `write <namespace>://<peer>` sends the written
 *   text to that peer over the socket (the peer's ack is the write result), and composer tab
 *   completion offers the peer names.
 * - `pi.replies.expect(peerId)` — a message written to a peer expects an answer (unless the URL
 *   carries `?notify`), so `wait` blocks for it instead of reporting "Nothing to wait for". The
 *   expectation is released when that peer's next message reaches the transcript, or when the
 *   socket drops.
 * - `pi.sendMessage(..., { deliverAs: "steer", triggerTurn: true })` — a message arriving on the
 *   socket is injected into the session: it steers a running turn (ending a `wait`) or starts one.
 *
 * The peer side is `peer-cli.ts`, which writes the roster file, listens on the socket, prints what
 * omp sends and lets a human type messages as any rostered peer. Only the top-level session talks
 * to the mesh: subagent loads of this extension stay inactive, and the scheme refuses writes from
 * any session but the one that connected.
 *
 * Configuration: `OMP_PEER_BRIDGE_ROSTER=<path>` names the roster JSON written by the peer CLI.
 *
 *   OMP_PEER_BRIDGE_ROSTER=/tmp/omp-peer-bridge/roster.json omp -e "$PWD/examples/extensions/url-scheme-bridge/extension.ts"
 */
import type { ExtensionAPI, InternalUrl, ProtocolHandler, WriteContext } from "@oh-my-pi/pi-coding-agent";
import {
	type BridgeMessage,
	LineDecoder,
	LineWriter,
	type PeerMessage,
	parseRoster,
	type Receipt,
	type Roster,
} from "./protocol";

/** How long an outbound message waits for the peer's ack before the write fails. */
const ACK_TIMEOUT_MS = 10_000;
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;
/** Custom message type of injected peer messages. */
const PEER_MESSAGE_TYPE = "url-scheme-bridge";

export interface PeerMessageDetails {
	/** Display id of the sender, `@<namespace>/<peer>`. */
	from: string;
	/** Whether the peer asked for an answer. */
	expectsReply: boolean;
}

export default function urlSchemeBridge(pi: ExtensionAPI): void {
	const rosterPath = Bun.env.OMP_PEER_BRIDGE_ROSTER;
	if (!rosterPath) {
		pi.logger.warn("url-scheme-bridge: OMP_PEER_BRIDGE_ROSTER is not set; bridge inactive");
		return;
	}

	let roster: Roster | undefined;
	let agentId = "";
	let socket: Bun.Socket | undefined;
	let shuttingDown = false;
	let reconnectDelay = RECONNECT_MIN_MS;
	let reconnectTimer: Timer | undefined;
	let nextId = 1;
	const pendingAcks = new Map<string, { resolve: (receipt: Receipt) => void; timer: Timer }>();
	/** Releases of `pi.replies.expect`, per bare peer name: the peer's next message answers them. */
	const awaiting = new Map<string, Array<() => void>>();
	// Records are queued and drained rather than written blind: a long body or a backed-up peer can
	// make `socket.write` accept a prefix, and a truncated line would time out its ack and corrupt
	// the next record (see LineWriter).
	const writer = new LineWriter();

	const displayId = (peer: string): string => `@${roster?.namespace ?? "?"}/${peer}`;

	const releaseAwaiting = (peer?: string): void => {
		const peers = peer === undefined ? [...awaiting.keys()] : [peer];
		for (const name of peers) {
			for (const release of awaiting.get(name) ?? []) release();
			awaiting.delete(name);
		}
	};

	const failPendingAcks = (error: string): void => {
		for (const pending of pendingAcks.values()) {
			clearTimeout(pending.timer);
			pending.resolve({ outcome: "failed", error });
		}
		pendingAcks.clear();
	};

	/** The peer a `<namespace>://<peer>` URL names, or an error naming the rostered peers. */
	const peerOf = (url: InternalUrl): string => {
		const peer = url.rawHost;
		if (!roster?.peers.includes(peer)) {
			throw new Error(`${displayId(peer)} is not a rostered peer (${roster?.peers.join(", ") ?? "none"})`);
		}
		return peer;
	};

	/** Outbound: one JSON line to the peer; its ack becomes the write result. */
	const sendToPeer = (peer: string, body: string, expectsReply: boolean): Promise<Receipt> => {
		const id = `omp-${nextId++}`;
		const { promise, resolve } = Promise.withResolvers<Receipt>();
		const timer = setTimeout(() => {
			pendingAcks.delete(id);
			resolve({ outcome: "failed", error: "the peer did not ack in time" });
		}, ACK_TIMEOUT_MS);
		pendingAcks.set(id, { resolve, timer });
		const written = writer.write({ type: "outbound", id, from: agentId, to: peer, body, expectsReply });
		if (!written) {
			clearTimeout(timer);
			pendingAcks.delete(id);
			resolve({ outcome: "failed", error: `the peer socket ${roster?.socket ?? ""} is not connected` });
		}
		return promise;
	};

	const handler: ProtocolHandler = {
		scheme: "",
		spec: {
			backing: "remote",
			selectors: "none",
			immutable: false,
			// A message to a peer, like `write agent://<id>`: read tier, and allowed in plan mode.
			write: { via: "handler", payload: "verbatim", scope: "coordination", tier: () => "read" },
		},
		async resolve(url) {
			if (!roster) throw new Error("url-scheme-bridge: not connected yet");
			const scheme = roster.namespace;
			if (url.rawHost === "") {
				const lines = [
					`# Peers on ${scheme}://`,
					"",
					`Socket: ${writer.connected ? "connected" : "disconnected"}`,
					"",
					...roster.peers.map(peer => `- \`${scheme}://${peer}\` (${displayId(peer)})`),
					"",
					`Message a peer with \`write ${scheme}://<peer>\`; it is expected to answer, and its answer arrives as a message (\`wait\` blocks for it). Add \`?notify\` to the URL for a message that needs no answer.`,
				];
				return { url: url.href, content: lines.join("\n"), contentType: "text/markdown" };
			}
			const peer = peerOf(url);
			const content = [
				`# ${displayId(peer)}`,
				"",
				`A peer in another process. It has no transcript here; message it with \`write ${scheme}://${peer}\`.`,
			].join("\n");
			return { url: url.href, content, contentType: "text/markdown" };
		},
		async write(url, content, context?: WriteContext) {
			const peer = peerOf(url);
			const caller = context?.session?.getAgentId?.();
			if (caller !== undefined && caller !== agentId) {
				throw new Error(`url-scheme-bridge: only the top-level session (${agentId}) talks to the mesh`);
			}
			const expectsReply = !url.searchParams.has("notify");
			// Expect before sending: an answer can arrive before the ack.
			const release = expectsReply ? pi.replies.expect(displayId(peer)) : undefined;
			if (release) awaiting.set(peer, [...(awaiting.get(peer) ?? []), release]);
			const receipt = await sendToPeer(peer, content, expectsReply);
			if (receipt.outcome === "failed") {
				release?.();
				throw new Error(`Not delivered to ${displayId(peer)}: ${receipt.error ?? "unknown error"}`);
			}
			const text = expectsReply
				? `Delivered to ${displayId(peer)}. Its answer arrives as a message.`
				: `Delivered to ${displayId(peer)}.`;
			return { content: [{ type: "text", text }] };
		},
		async complete() {
			return (roster?.peers ?? []).map(peer => ({ value: peer, description: displayId(peer) }));
		},
	};

	/** Inbound: a peer line becomes a steered message; the receipt goes back on the same socket. */
	const handlePeerMessage = (message: PeerMessage): void => {
		if (message.type === "ack") {
			const pending = pendingAcks.get(message.id);
			if (!pending) return;
			pendingAcks.delete(message.id);
			clearTimeout(pending.timer);
			pending.resolve(message.receipt);
			return;
		}
		if (!roster?.peers.includes(message.from)) {
			writer.write({
				type: "receipt",
				id: message.id,
				receipt: { outcome: "failed", error: `${message.from} is not a rostered peer` },
			});
			return;
		}
		const from = displayId(message.from);
		const hint = message.expectsReply ? ` (answer with \`write ${roster.namespace}://${message.from}\`)` : "";
		const details: PeerMessageDetails = { from, expectsReply: message.expectsReply };
		pi.sendMessage(
			{ customType: PEER_MESSAGE_TYPE, content: `[${from}]${hint} ${message.body}`, display: true, details },
			{ deliverAs: "steer", triggerTurn: true },
		);
		// The message answers whatever the agent asked this peer. Its expectation is released once the
		// message reaches the transcript (`message_start` below), not here: the steer has to end a
		// running `wait` first, and a release now would end it with "no longer owes a reply" instead.
		writer.write({ type: "receipt", id: message.id, receipt: { outcome: "delivered" } });
	};

	const connect = (): void => {
		if (shuttingDown || !roster) return;
		const decoder = new LineDecoder<PeerMessage>((line, error) =>
			pi.logger.warn("url-scheme-bridge: dropped malformed peer line", { line, error: String(error) }),
		);
		const path = roster.socket;
		Bun.connect({
			unix: path,
			socket: {
				open(connected) {
					socket = connected;
					writer.attach(connected);
					reconnectDelay = RECONNECT_MIN_MS;
					writer.write({ type: "hello", agentId, namespace: roster?.namespace ?? "" } satisfies BridgeMessage);
					pi.logger.info("url-scheme-bridge: connected", { socket: path });
				},
				drain() {
					writer.flush();
				},
				data(_connected, chunk) {
					for (const message of decoder.push(chunk)) handlePeerMessage(message);
				},
				close() {
					socket = undefined;
					writer.detach();
					failPendingAcks("the peer disconnected before acking");
					// No answer can come over a dropped connection.
					releaseAwaiting();
					scheduleReconnect();
				},
				error(_connected, error) {
					pi.logger.warn("url-scheme-bridge: socket error", { socket: path, error: error.message });
				},
			},
		}).catch(error => {
			pi.logger.debug("url-scheme-bridge: connect failed, retrying", { socket: path, error: String(error) });
			scheduleReconnect();
		});
	};

	const scheduleReconnect = (): void => {
		if (shuttingDown) return;
		reconnectTimer = setTimeout(connect, reconnectDelay);
		reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
	};

	pi.on("message_start", async event => {
		const message = event.message;
		if (message.role !== "custom" || message.customType !== PEER_MESSAGE_TYPE) return;
		const from: unknown =
			typeof message.details === "object" && message.details !== null
				? Reflect.get(message.details, "from")
				: undefined;
		if (typeof from === "string") releaseAwaiting(from.slice(`@${roster?.namespace ?? ""}/`.length));
	});

	pi.on("session_start", async (_event, ctx) => {
		// Only the top-level session connects; a subagent's load of this extension stays inactive.
		if (ctx.agent.kind !== "main") return;
		agentId = ctx.agent.id;
		roster = parseRoster(await Bun.file(rosterPath).json());
		// The scheme is released with this load (session shutdown, live disable); no teardown needed.
		pi.registerUrlScheme({ ...handler, scheme: roster.namespace });
		connect();
	});

	pi.on("session_shutdown", async () => {
		// The scheme and any unreleased expectations go with the load; only the socket is ours to close.
		shuttingDown = true;
		clearTimeout(reconnectTimer);
		failPendingAcks("the session shut down");
		socket?.end();
		socket = undefined;
		writer.detach();
	});
}
