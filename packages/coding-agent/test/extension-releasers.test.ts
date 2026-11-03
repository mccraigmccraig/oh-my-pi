import { describe, expect, it } from "bun:test";
import { emitSessionShutdownEvent, ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import type { Extension, ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

/**
 * Contract: what an extension load registers outside its session state is released exactly once
 * when the load is torn down — session shutdown (suspended loads included) or live suspension —
 * and a resume does not bring it back. (A throwing factory is covered through the public APIs that
 * register releasers.)
 */
function runtime(): ExtensionRuntime {
	return { flagValues: new Map(), pendingProviderRegistrations: [] } as unknown as ExtensionRuntime;
}

function runnerFor(extensions: Extension[]): ExtensionRunner {
	return new ExtensionRunner(extensions, runtime(), "/tmp", { getCwd: () => "/tmp" } as never, {} as never);
}

async function load(name: string, released: string[]): Promise<Extension> {
	const extension = await loadExtensionFromFactory(() => {}, "/tmp", new EventBus(), runtime(), name);
	extension.releasers?.push(() => released.push(name));
	return extension;
}

describe("extension load releasers", () => {
	it("run once on session shutdown, for suspended loads too", async () => {
		const released: string[] = [];
		const active = await load("active", released);
		const suspended = await load("suspended", released);
		const runner = runnerFor([active, suspended]);
		runner.setSuspendedExtensions(extension => extension === suspended);
		expect(released).toEqual(["suspended"]);

		await emitSessionShutdownEvent(runner);
		await emitSessionShutdownEvent(runner);

		expect(released).toEqual(["suspended", "active"]);
	});

	it("run when a load is suspended, and a resume does not re-arm them", async () => {
		const released: string[] = [];
		const extension = await load("bridge", released);
		const runner = runnerFor([extension]);

		runner.setSuspendedExtensions(() => true);
		runner.setSuspendedExtensions(() => false);
		await emitSessionShutdownEvent(runner);

		expect(released).toEqual(["bridge"]);
	});
});
