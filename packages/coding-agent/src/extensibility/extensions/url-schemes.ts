/**
 * Internal URL schemes extensions register on the process-global router (`pi.registerUrlScheme`).
 *
 * A scheme belongs to one extension source. Every load of that source — the root session's and each
 * subagent's — may register it; the scheme stays routed while any of those registrations is live,
 * served by the earliest live one.
 */
import { assertProtocolHandlerSpec, type InternalUrlRouter } from "../../internal-urls/router";
import type { ProtocolHandler } from "../../internal-urls/types";

/** RFC 3986 scheme syntax, after lowercasing (as host-provided RPC schemes). */
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*$/;

/** One live `registerUrlScheme` call; an object so a handler registered twice counts twice. */
interface SchemeHolder {
	handler: ProtocolHandler;
}

/** The extension source owning a scheme, and its live registrations, oldest first (the first serves). */
interface SchemeClaim {
	source: string;
	holders: SchemeHolder[];
}

/** Claims per router, so a router reset in tests starts without stale ownership. */
const claimsByRouter = new WeakMap<InternalUrlRouter, Map<string, SchemeClaim>>();

/**
 * Register `handler` on `router` for the extension source `source` and return its idempotent release.
 *
 * Throws for invalid scheme syntax, an OMP-owned scheme, a scheme another source claims, a scheme
 * registered outside extensions (RPC host URIs), or a handler whose spec fails
 * {@link assertProtocolHandlerSpec}. A source that already claims the scheme adds a registration:
 * the serving handler stays the earliest live one. Releasing the serving registration hands the
 * scheme to the next live one; releasing the last unregisters it. A release never touches a handler
 * someone else installed for the scheme in the meantime.
 */
export function claimExtensionUrlScheme(
	router: InternalUrlRouter,
	source: string,
	handler: ProtocolHandler,
): () => void {
	const scheme = handler.scheme.toLowerCase();
	if (!SCHEME_PATTERN.test(scheme)) {
		throw new Error(
			`registerUrlScheme: "${handler.scheme}" is not a URL scheme (a letter, then letters, digits, "+", "-", ".")`,
		);
	}
	if (router.isBuiltin(scheme)) throw new Error(`registerUrlScheme: ${scheme}:// is reserved by OMP`);

	let claims = claimsByRouter.get(router);
	if (!claims) {
		claims = new Map();
		claimsByRouter.set(router, claims);
	}
	const holder: SchemeHolder = { handler };
	const installed = router.getHandler(scheme);
	let claim = claims.get(scheme);
	if (claim) {
		if (claim.source !== source) {
			throw new Error(`registerUrlScheme: ${scheme}:// is registered by extension ${claim.source}`);
		}
		if (installed !== claim.holders[0]?.handler) {
			throw new Error(`registerUrlScheme: ${scheme}:// is registered outside extensions`);
		}
		assertProtocolHandlerSpec(handler);
		claim.holders.push(holder);
	} else {
		if (installed) throw new Error(`registerUrlScheme: ${scheme}:// is registered outside extensions`);
		router.register(handler);
		claim = { source, holders: [holder] };
		claims.set(scheme, claim);
	}

	const owned = claim;
	const ownedClaims = claims;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const index = owned.holders.indexOf(holder);
		owned.holders.splice(index, 1);
		if (index !== 0) return;
		const serving = router.getHandler(scheme) === handler;
		const next = owned.holders[0];
		if (next) {
			if (serving) router.register(next.handler);
			return;
		}
		ownedClaims.delete(scheme);
		if (serving) router.unregister(scheme);
	};
}
