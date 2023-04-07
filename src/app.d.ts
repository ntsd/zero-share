import type { MetaData } from "./proto/message";
import type { EventEmitter } from "eventemitter3";

declare global {
	namespace App {
		// See https://kit.svelte.dev/docs/types#app
		// for information about these interfaces
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface Platform {}
	}

	interface SendingFile {
		metaData: MetaData;
		file: File;
		progress: number;
		success: boolean;
		error?: Error;
		event?: EventEmitter;
	}

	interface ReceivingFile {
		metaData: MetaData;
		receivedSize: number;
		receivedChunks: Uint8Array[];
		progress: number;
		success: boolean;
	}
}

export { };
