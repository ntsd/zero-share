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

export interface ReceivingFile extends FileDetail {
  receivedSize: number;
  receivedChunks: Uint8Array[];
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
