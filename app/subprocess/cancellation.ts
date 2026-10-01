/** Keep the Node child alive while its abort signal unwinds protected sessions. */
export function installSubprocessCancellation(controller: AbortController): () => void {
  const cancel = (): void => controller.abort();
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  // Python starts a separate process group on Windows. CTRL_BREAK_EVENT is a
  // catchable console event there; CTRL_C_EVENT is not reliable for that group.
  if (process.platform === 'win32') process.on('SIGBREAK', cancel);
  return () => {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    if (process.platform === 'win32') process.removeListener('SIGBREAK', cancel);
  };
}
