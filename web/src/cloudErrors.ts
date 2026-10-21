export class CloudUploadError extends Error {
  readonly name = 'CloudUploadError';
  constructor(message: string, public readonly retryable: boolean, public readonly status?: number) {
    super(message);
  }
}

export async function uploadError(error: { message: string; context?: unknown }): Promise<CloudUploadError> {
  const response = error.context instanceof Response ? error.context : undefined;
  const payload = response ? await response.clone().json().catch(() => null) as { error?: string } | null : null;
  const status = response?.status;
  // Authentication and consent need user action; retrying them in a timer loop
  // cannot help. Network failures, rate limits and server errors can recover.
  const retryable = !status || status === 408 || status === 429 || status >= 500;
  return new CloudUploadError(payload?.error || error.message, retryable, status);
}
