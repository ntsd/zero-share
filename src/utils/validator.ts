import type { MetaData } from '../proto/message';
import { humanFileSize } from './humanFIleSize';

export function validateFileMetadata(metadata: MetaData, maxSize?: number): Error | undefined {
  // metaData.size is peer-controlled (the remote side picks it) and is the
  // value the receiver uses as its "done" gate. A size of 0 / negative /
  // non-finite would make the receiver flip a file to Success on the first
  // chunk with a partial/empty payload, or make the progress math NaN /
  // negative. 0-byte files are rejected with this explicit error instead of
  // dead-ending the transfer on both sides.
  if (!Number.isFinite(metadata.size) || metadata.size <= 0) {
    return new Error('invalid file size');
  }
  if (maxSize && metadata.size > maxSize) {
    return new Error(`file is exceed max size at ${humanFileSize(maxSize)}`);
  }
}
