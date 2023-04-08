import type { MetaData } from '../proto/message';

export function validateFileMetadata(metadata: MetaData): Error | undefined {
  const maxSize = 1024 * 1024 * 1024; // 1GB

  if (metadata.size > maxSize) {
    return new Error('file is too large');
  }
}
