import type { ChildContextBoundaryOptions, PersistedSubagentLaunchMetadata, SubagentSessionMode } from "./session-files.ts";
import {
	readSubagentExtensionEntry,
	readSubagentLaunchMetadata,
	seedSubagentSessionFile,
	writeChildContextBoundaryEntry,
	writeSubagentExtensionEntry,
	writeSubagentLaunchMetadataEntryWhenReady,
	writeSubagentModelStateEntries,
} from "./session-files.ts";

export interface ChildSessionSeedOptions {
	sessionName?: string;
	activeLeafId?: string | null;
}

export class ChildSessionStorage {
	readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	seed(
		mode: Exclude<SubagentSessionMode, "standalone">,
		parentSessionFile: string,
		cwd: string,
		options?: ChildSessionSeedOptions,
	): void {
		seedSubagentSessionFile(mode, parentSessionFile, this.path, cwd, options);
	}

	writeBoundary(options: ChildContextBoundaryOptions, content: string): void {
		writeChildContextBoundaryEntry(this.path, options, content);
	}

	writeExtensionEntry(extensions: string[] | undefined): void {
		writeSubagentExtensionEntry(this.path, extensions);
	}

	readExtensionEntry(): string[] | undefined {
		return readSubagentExtensionEntry(this.path);
	}

	writeModelState(metadata: Pick<PersistedSubagentLaunchMetadata, "model" | "thinking">): void {
		writeSubagentModelStateEntries(this.path, metadata);
	}

	async writeLaunchMetadataWhenReady(
		metadata: PersistedSubagentLaunchMetadata,
		timeoutMs = 5000,
	): Promise<void> {
		await writeSubagentLaunchMetadataEntryWhenReady(this.path, metadata, timeoutMs);
	}

	readLaunchMetadata(): PersistedSubagentLaunchMetadata | undefined {
		return readSubagentLaunchMetadata(this.path);
	}
}
