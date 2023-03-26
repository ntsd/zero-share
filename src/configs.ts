export const rtcConfig: RTCConfiguration = {
	iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

export const chunkSize: number = 16 * 1024; // 16KB