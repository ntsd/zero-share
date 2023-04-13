import type { ReceiveOptions, SendOptions } from './type';

export const rtcConfig: RTCConfiguration = {
  iceServers: [
    {
      urls: ['stun:stun.l.google.com:19302', 'stun:stun.l.google.com:19305']
    },
    {
      urls: ['stun:stun1.l.google.com:19302', 'stun:stun1.l.google.com:19305']
    },
    {
      urls: ['stun:stun2.l.google.com:19302', 'stun:stun2.l.google.com:19305']
    },
    {
      urls: ['stun:stun3.l.google.com:19302', 'stun:stun3.l.google.com:19305']
    },
    {
      urls: ['stun:stun4.l.google.com:19302', 'stun:stun4.l.google.com:19305']
    }
  ]
};

export const pageDescription = 'A secure P2P file sharing using WebRTC without a server.';

export const githubLink = 'https://github.com/ntsd/zero-share';

export const defaultSendOptions: SendOptions = {
  chunkSize: 16 * 1024,
  isEncrypt: false
};

export const defaultReceiveOptions: ReceiveOptions = {
  autoAccept: true,
  maxSize: 1024 * 1024 * 1024 // 1GB
};
