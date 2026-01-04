import type { MetaData } from './proto/message';
import type { EventEmitter } from 'eventemitter3';

export enum FileStatus {
  Pending = 'Pending',
  WaitingAccept = 'WaitingAccept',
  Processing = 'Processing',
  Success = 'Success'
}

export interface FileDetail {
  metaData: MetaData;
  progress: number; // percentage
  bitrate: number; // bytes per second
  error?: Error;
  startTime: number;
  status: FileStatus;
  aesKey?: CryptoKey;
}

export interface SendingFile extends FileDetail {
  stop: boolean;
  file: File;
  event?: EventEmitter;
}

export interface SendOptions {
  isEncrypt: boolean;
  chunkSize: number;
  iceServer: string;
}

export interface ReceiveOptions {
  autoAccept: boolean;
  maxSize: number;
}

// File Stats during sending or receiving
// For non UI updates state, to reduce UI updates frequency
export interface FileStats {
  // percentage
  progress: number;
  startTime: number;
  // next progress to update UI, if progress >= nextProgressUpdate, update UI and increase nextProgressUpdate by PROGRESS_UPDATE_UI_STEP
  nextProgressUpdate: number;
}

// Extends FileStats to include received size
// For non UI update state during receiving
export interface ReceivingFileStats extends FileStats {
  receivedSize: number;
}

// Receiving file chunks, use to accumulate received chunks
// For non UI update state chunk received, to reduce UI updates frequency
export interface ReceivingFileChunks {
  receivedChunks: Uint8Array<ArrayBuffer>[];
}
