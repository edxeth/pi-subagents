import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function isMissingOptionalDependency(error: unknown, id: string): boolean {
	const maybeError = error as { code?: unknown; message?: unknown } | null;
	const message = typeof maybeError?.message === "string" ? maybeError.message : "";
	const code = maybeError?.code;
	return (
		(code === "MODULE_NOT_FOUND" || code == null) &&
		(message.includes("Cannot find module") || message.includes("Cannot find package")) &&
		message.includes(id)
	);
}

export function optionalRequire(id: string): unknown | null {
	try {
		return require(id);
	} catch (error) {
		if (isMissingOptionalDependency(error, id)) return null;
		throw error;
	}
}
