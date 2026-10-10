// Per-key promise-chain serializer: each task for a key runs only after the
// previous task for that key has settled, in the order the tasks were
// enqueued. Tasks for different keys run independently.
//
// Used by the receiver to serialize per-file chunk processing, so the
// post-await work (pushing the decrypted chunk, stats, blob-on-completion)
// happens in strict arrival order even when the async decryption calls
// complete out of order.
export function serializeTask(
  queue: { [key: string]: Promise<unknown> },
  key: string,
  task: () => Promise<unknown> | unknown
): Promise<unknown> {
  const next = (queue[key] ?? Promise.resolve()).then(task);
  // The chain itself swallows rejections so one failed task cannot stall the
  // queue for subsequent tasks; the returned promise still rejects with the
  // original error for the caller.
  queue[key] = next.catch(() => {});
  return next;
}
