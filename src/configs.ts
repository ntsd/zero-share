import type { ReceiveOptions, SendOptions } from './type';

export const STUN_SERVERS: string[] = [
  'stun:stun.l.google.com:19302',
  'stun:stun.l.google.com:19305',
  'stun:stun4.l.google.com:19302',
  'stun:stun4.l.google.com:19305',
  'stun:stun.sipgate.net:3478',
  'stun:stun.sipgate.net:10000',
  'stun.nextcloud.com:3478',
  'stun.nextcloud.com:443',
  'stun:stun.myvoipapp.com:3478',
  'stun:stun.voipstunt.com:3478'
];

export const PAGE_DESCRIPTION = 'A client-side secure P2P file sharing using WebRTC.';

export const GITHUB_LINK = 'https://github.com/ntsd/zero-share';

export const DEFAULT_SEND_OPTIONS: SendOptions = {
  chunkSize: 32 * 1024, // 32KB
  isEncrypt: false,
  iceServer: STUN_SERVERS[0]
};

export const DEFAULT_RECEIVE_OPTIONS: ReceiveOptions = {
  autoAccept: true,
  maxSize: 1024 * 1024 * 1024 // 1GB
};

export const WAIT_ICE_CANDIDATES_TIMEOUT = 3000; // 3 seconds

export const PROGRESS_UPDATE_UI_STEP = 3; // percentage
