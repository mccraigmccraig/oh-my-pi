import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { executeList } from "@oh-my-pi/pi-coding-agent/tools/hub/messaging";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("hub list", () => {
	it("restores persisted peers after the process registry is lost", async () => {
		using tempDir = TempDir.createSync("@omp-hub-list-persisted-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		const workerSessionFile = path.join(tempDir.path(), "main", "Worker.jsonl");
		await Bun.write(sessionFile, "");
		await Bun.write(workerSessionFile, "");

		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			sessionFile,
			status: "running",
		});

		const result = await executeList(registry, MAIN_AGENT_ID);
		if (!result.details) throw new Error("Expected coordination details");

		expect(result.details.peers).toEqual([
			expect.objectContaining({
				id: "Worker",
				kind: "sub",
				status: "parked",
				parentId: MAIN_AGENT_ID,
			}),
		]);
		const content = result.content[0];
		if (content?.type !== "text") throw new Error("Expected text result");
		expect(content.text).toContain("Worker");
		expect(content.text).toContain("parked");
		expect(registry.get("Worker")?.sessionFile).toBe(workerSessionFile);
	});

	it("still restores persisted peers when only a remote proxy is in memory (murmur-q00p)", async () => {
		using tempDir = TempDir.createSync("@omp-hub-list-remote-guard-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		const workerSessionFile = path.join(tempDir.path(), "main", "Worker.jsonl");
		await Bun.write(sessionFile, "");
		await Bun.write(workerSessionFile, "");

		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			sessionFile,
			status: "running",
		});
		// A seeded remote proxy must NOT suppress the persisted-subagent disk restore.
		registry.register({
			id: "remote-peer",
			displayName: "remote-peer",
			kind: "remote",
			session: null,
			status: "idle",
		});

		const result = await executeList(registry, MAIN_AGENT_ID);
		if (!result.details) throw new Error("Expected coordination details");

		const ids = (result.details.peers ?? []).map(peer => peer.id);
		expect(ids).toContain("Worker"); // restored from disk despite the remote proxy in memory
		expect(ids).toContain("remote-peer"); // remotes are still listed as peers
	});
});
