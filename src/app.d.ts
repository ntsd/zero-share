import type { MetaData } from './proto/message';
import type { EventEmitter } from 'eventemitter3';

declare global {
  namespace App {
    // See https://kit.svelte.dev/docs/types#app
    // for information about these interfaces
  }

  interface FileDetail {
    metaData: MetaData;
    progress: number;
    bitrate: number;
    processing: boolean;
    success: boolean;
    error?: Error;
  }

  interface SendingFile extends FileDetail {
    stop: boolean;
    file: File;
    event?: EventEmitter;
  }

  interface ReceivingFile extends FileDetail {
    receivedSize: number;
    receivedChunks: Uint8Array[];
  }
}

export {};
