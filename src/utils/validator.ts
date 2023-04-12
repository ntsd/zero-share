import type { MetaData } from '../proto/message';
import { humanFileSize } from './humanFIleSize';

export function validateFileMetadata(metadata: MetaData, maxSize?: number): Error | undefined {
  if (maxSize && metadata.size > maxSize) {
    return new Error(`file is exceed max size at ${humanFileSize(maxSize)}`);
  }
}
