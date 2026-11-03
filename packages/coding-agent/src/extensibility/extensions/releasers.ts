/**
 * Teardown of the registrations an extension load makes outside its own session state.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { Extension } from "./types";

/**
 * Run and drop the releasers of `extension` (newest first, each once), so registrations the load
 * made outside its session state do not outlive it. A releaser that throws is logged and skipped.
 */
export function releaseExtensionRegistrations(extension: Extension): void {
	const releasers = extension.releasers?.splice(0) ?? [];
	for (const release of releasers.reverse()) {
		try {
			release();
		} catch (error) {
			logger.warn("Extension releaser failed", {
				extensionPath: extension.path,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}
