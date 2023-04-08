export const rtcConfig: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

export const chunkSize: number = 16 * 1024; // 16KB

export const pageDescription = 'A secure P2P file sharing using WebRTC without a server.';

export const githubLink = 'https://github.com/ntsd/zero-share';
