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

export const chunkSize: number = 16 * 1024; // 16KB

export const pageDescription = 'A secure P2P file sharing using WebRTC without a server.';

export const githubLink = 'https://github.com/ntsd/zero-share';
