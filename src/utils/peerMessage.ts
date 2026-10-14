import { Message, type MetaData, type ReceiveEvent } from '../proto/message';
import { addToastMessage } from '../stores/toastStore';

export interface PeerMessageHandlers {
  onMetaData: (id: string, metaData: MetaData) => void;
  onChunkData: (id: string, chunk: Uint8Array<ArrayBuffer>) => void;
  onReceiveEvent: (id: string, receiveEvent: ReceiveEvent) => void;
}

// Decodes one peer-controlled data-channel frame and dispatches it to the
// matching handler. The decode is guarded: data-channel bytes are controlled
// by the remote peer, so a malformed/truncated protobuf frame makes
// Message.decode throw synchronously, which would otherwise escape as an
// uncaught error and stall the transfer with no feedback.
// Returns false when the frame was invalid, or when no oneof payload is set
// (an empty frame is silently dropped — matching both pages' behavior
// before this handler was extracted).
export function handlePeerMessage(event: MessageEvent, handlers: PeerMessageHandlers): boolean {
  let message;
  try {
    message = Message.decode(new Uint8Array(event.data));
  } catch {
    addToastMessage('Invalid message from peer', 'error');
    return false;
  }

  if (message.metaData !== undefined) {
    handlers.onMetaData(message.id, message.metaData);
    return true;
  } else if (message.chunk !== undefined) {
    handlers.onChunkData(message.id, message.chunk as Uint8Array<ArrayBuffer>);
    return true;
  } else if (message.receiveEvent !== undefined) {
    handlers.onReceiveEvent(message.id, message.receiveEvent);
    return true;
  }
  return false;
}
