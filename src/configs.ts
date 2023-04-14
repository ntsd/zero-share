import type { ReceiveOptions, SendOptions } from './type';

export const stunServers: string[] = [
  'stun:stun.l.google.com:19302',
  'stun:stun.l.google.com:19305',
  'stun:stun1.l.google.com:19302',
  'stun:stun1.l.google.com:19305',
  'stun:stun2.l.google.com:19302',
  'stun:stun2.l.google.com:19305',
  'stun:stun3.l.google.com:19302',
  'stun:stun3.l.google.com:19305',
  'stun:stun4.l.google.com:19302',
  'stun:stun4.l.google.com:19305'
];

export const pageDescription = 'A secure P2P file sharing using WebRTC without a server.';

export const githubLink = 'https://github.com/ntsd/zero-share';

export const defaultSendOptions: SendOptions = {
  chunkSize: 16 * 1024,
  isEncrypt: true,
  iceServer: stunServers[0]
};

export const defaultReceiveOptions: ReceiveOptions = {
  autoAccept: true,
  maxSize: 1024 * 1024 * 1024 // 1GB
};
