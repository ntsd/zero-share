import type { MetaData } from '../proto/message';
import { humanFileSize } from './humanFileSize';

export function validateFileMetadata(metadata: MetaData, maxSize?: number): Error | undefined {
  // metaData.size is peer-controlled (the remote side picks it) and is the
  // value the receiver uses as its "done" gate. A size of 0 / negative /
  // non-finite would make the receiver flip a file to Success on the first
  // chunk with a partial/empty payload, or make the progress math NaN /
  // negative. 0-byte files are rejected with this explicit error instead of
  // dead-ending the transfer on both sides. A fractional size (e.g. 0.5)
  // can never satisfy the receiver's exact-match gate
  // (receivedSize === metaData.size — receivedSize is a sum of integer chunk
  // byte lengths), so it would accept the file and then dead-end the
  // transfer forever; reject it early instead.
  if (!Number.isFinite(metadata.size) || metadata.size <= 0 || !Number.isInteger(metadata.size)) {
    return new Error('invalid file size');
  }
  if (maxSize && metadata.size > maxSize) {
    return new Error(`file is exceed max size at ${humanFileSize(maxSize)}`);
  }
}
