import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { releaseExtensionRegistrations } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/releasers";
import { emitSessionShutdownEvent, ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	Extension,
	ExtensionAPI,
	ExtensionRuntime,
	ProtocolHandler,
	ResolveContext,
	WriteContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { RpcHostUriBridge } from "@oh-my-pi/pi-coding-agent/modes/rpc/host-uris";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { getInternalUrlSuggestions } from "@oh-my-pi/pi-tui/prompt/internal-url-autocomplete";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

/**
 * Contract: `pi.registerUrlScheme` routes `read`, `write` and composer completion of its scheme to
 * the extension's handler with the caller's context; a scheme belongs to one extension source, is
 * shared by every load of that source (root + subagents) until the last releases, and leaves the
 * process-global router when the load is torn down.
 */
function runtime(): ExtensionRuntime {
	return { flagValues: new Map(), pendingProviderRegistrations: [] } as unknown as ExtensionRuntime;
}

async function load(source: string, factory: (pi: ExtensionAPI) => void = () => {}): Promise<Extension> {
	return loadExtensionFromFactory(factory, "/tmp", new EventBus(), runtime(), source);
}

/** Load `source` and keep its API so a test can register after the factory returns. */
async function loadWithApi(source: string): Promise<{ extension: Extension; pi: ExtensionAPI }> {
	let api: ExtensionAPI | undefined;
	const extension = await load(source, pi => {
		api = pi;
	});
	if (!api) throw new Error("factory did not run");
	return { extension, pi: api };
}

/** Read-only scheme whose resources name the handler that served them. */
function readOnly(scheme: string, label: string): ProtocolHandler {
	return {
		scheme,
		spec: { backing: "remote", selectors: "none", immutable: true },
		resolve: async url => ({ url: url.href, content: `${label}:${url.href}`, contentType: "text/plain" }),
	};
}

function served(scheme: string): Promise<string> {
	return InternalUrlRouter.instance()
		.resolve(`${scheme}://x`)
		.then(resource => resource.content);
}

beforeEach(() => {
	InternalUrlRouter.resetForTests();
});

afterEach(() => {
	InternalUrlRouter.resetForTests();
});

describe("pi.registerUrlScheme routing", () => {
	let tmpDir: string;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "extension-url-schemes-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("routes read, write and composer completion to the handler with the caller's context", async () => {
		const reads: ResolveContext[] = [];
		const writes: Array<{ href: string; content: string; context: WriteContext | undefined }> = [];
		const completions: Array<{ query: string | undefined; context: ResolveContext | undefined }> = [];
		const handler: ProtocolHandler = {
			scheme: "murmur",
			spec: {
				backing: "remote",
				selectors: "none",
				immutable: false,
				write: { via: "handler", payload: "verbatim", scope: "coordination", tier: () => "write" },
			},
			resolve: async (url, context) => {
				if (context) reads.push(context);
				return { url: url.href, content: `inbox of ${url.host}`, contentType: "text/plain" };
			},
			write: async (url, content, context) => {
				writes.push({ href: url.href, content, context });
			},
			complete: async (query, context) => {
				completions.push({ query, context });
				return [{ value: "peer-a" }, { value: "other" }];
			},
		};
		await load("murmur-ext", pi => {
			pi.registerUrlScheme(handler);
		});
		const session: ToolSession = {
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => path.join(tmpDir, "session.jsonl"),
			getSessionSpawns: () => "*",
			getArtifactsDir: () => path.join(tmpDir, "artifacts"),
			settings: Settings.isolated({}),
			enableLsp: false,
		};

		const read = await new ReadTool(session).execute("read-1", { path: "murmur://peer-a" });
		expect(read.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n")).toContain(
			"inbox of peer-a",
		);
		expect(reads.at(-1)).toMatchObject({ cwd: tmpDir, sessionFile: path.join(tmpDir, "session.jsonl"), session });

		const write = new WriteTool(session);
		expect(write.approval({ path: "murmur://peer-a", content: "hi" })).toBe("write");
		await write.execute("write-1", { path: "murmur://peer-a", content: "hi" });
		expect(writes).toHaveLength(1);
		expect(writes[0]).toMatchObject({ href: "murmur://peer-a", content: "hi" });
		expect(writes[0]?.context).toMatchObject({ cwd: tmpDir, session });

		const suggestions = await getInternalUrlSuggestions("ask murmur://pe", undefined, undefined, () => ({
			cwd: tmpDir,
			sessionId: "session-1",
		}));
		expect(suggestions?.items.map(item => item.value)).toEqual(["murmur://peer-a"]);
		expect(completions.at(-1)).toMatchObject({ query: "pe", context: { cwd: tmpDir, sessionId: "session-1" } });
	});

	it("denies writes to a read-only extension scheme at the approval gate", async () => {
		await load("murmur-ext", pi => {
			pi.registerUrlScheme(readOnly("murmur", "root"));
		});
		const write = new WriteTool({ cwd: tmpDir, hasUI: false, settings: Settings.isolated({}) } as ToolSession);
		expect(write.approval({ path: "murmur://peer-a", content: "hi" })).toMatchObject({ policy: "deny" });
	});
});

describe("pi.registerUrlScheme ownership", () => {
	it("rejects OMP-owned, standard, malformed and RPC-host schemes", async () => {
		const { pi } = await loadWithApi("murmur-ext");
		for (const scheme of ["local", "Agent", "https", "1bad"]) {
			expect(() => pi.registerUrlScheme(readOnly(scheme, "ext"))).toThrow("registerUrlScheme");
		}
		const bridge = new RpcHostUriBridge(() => {});
		bridge.setSchemes([{ scheme: "db" }]);
		expect(() => pi.registerUrlScheme(readOnly("db", "ext"))).toThrow("registered outside extensions");
		bridge.clear("test cleanup");
		// The rejected registrations left the built-in and host handlers in place.
		expect(InternalUrlRouter.instance().fileWritable("local://x")).toBe(true);
	});

	it("rejects a scheme another extension source holds", async () => {
		const owner = await loadWithApi("murmur-ext");
		const other = await loadWithApi("other-ext");
		owner.pi.registerUrlScheme(readOnly("murmur", "owner"));

		expect(() => other.pi.registerUrlScheme(readOnly("murmur", "other"))).toThrow(
			"murmur:// is registered by extension murmur-ext",
		);
		expect(await served("murmur")).toBe("owner:murmur://x");
	});

	it("shares a scheme across loads of one source until the last load releases it", async () => {
		const root = await loadWithApi("murmur-ext");
		const subagent = await loadWithApi("murmur-ext");
		const releaseRoot = root.pi.registerUrlScheme(readOnly("murmur", "root"));
		subagent.pi.registerUrlScheme(readOnly("murmur", "subagent"));
		expect(await served("murmur")).toBe("root:murmur://x");

		releaseRoot();
		releaseRoot();
		releaseExtensionRegistrations(root.extension);
		expect(await served("murmur")).toBe("subagent:murmur://x");

		releaseExtensionRegistrations(subagent.extension);
		expect(InternalUrlRouter.instance().canHandle("murmur://x")).toBe(false);

		// A stale release never removes a later owner's registration.
		const next = await loadWithApi("other-ext");
		next.pi.registerUrlScheme(readOnly("murmur", "next"));
		releaseRoot();
		expect(await served("murmur")).toBe("next:murmur://x");
	});
});

describe("pi.registerUrlScheme teardown", () => {
	it("leaves the router on session shutdown", async () => {
		const extension = await load("murmur-ext", pi => {
			pi.registerUrlScheme(readOnly("murmur", "root"));
		});
		const runner = new ExtensionRunner(
			[extension],
			runtime(),
			"/tmp",
			{ getCwd: () => "/tmp" } as never,
			{} as never,
		);
		expect(InternalUrlRouter.instance().canHandle("murmur://x")).toBe(true);

		await emitSessionShutdownEvent(runner);

		expect(InternalUrlRouter.instance().canHandle("murmur://x")).toBe(false);
	});

	it("leaves the router when the registering factory throws", async () => {
		await expect(
			load("murmur-ext", pi => {
				pi.registerUrlScheme(readOnly("murmur", "failed"));
				throw new Error("factory failed");
			}),
		).rejects.toThrow("factory failed");

		expect(InternalUrlRouter.instance().canHandle("murmur://x")).toBe(false);
	});
});
