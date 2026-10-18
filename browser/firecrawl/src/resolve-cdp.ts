/** Optional bounds for the HTTP metadata request; WebSocket URLs need no discovery request. */
export interface CdpResolveOptions {
  timeoutMs?: number;
  maxRedirects?: 0;
}

/**
 * Resolve an HTTP CDP endpoint to a WebSocket URL (same behavior as MastraBrowser.resolveWebSocketUrl).
 */
export async function resolveCdpWebSocketUrl(
  url: string,
  logger?: { debug?: (message: string) => void; warn?: (message: string) => void },
  options?: CdpResolveOptions,
): Promise<string> {
  if (options?.maxRedirects !== undefined && options.maxRedirects !== 0) {
    throw new Error('maxRedirects must be 0 or undefined');
  }
  const timeoutMs = options?.timeoutMs ?? 10000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('CDP resolution timeoutMs must be positive and finite');
  if (url.startsWith('ws://') || url.startsWith('wss://')) {
    return url;
  }

  if (url.startsWith('http://') || url.startsWith('https://')) {
    const baseUrl = url.replace(/\/$/, '');
    const versionUrl = `${baseUrl}/json/version`;

    logger?.debug?.(`Resolving WebSocket URL from ${versionUrl}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(versionUrl, {
        signal: controller.signal,
        ...(options?.maxRedirects === 0 ? { redirect: 'error' as const } : {}),
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch CDP version info from ${versionUrl}: ${response.status} ${response.statusText}`,
        );
      }

      const data = (await response.json()) as { webSocketDebuggerUrl?: string };
      if (!data.webSocketDebuggerUrl) {
        throw new Error(`No webSocketDebuggerUrl found in CDP version response from ${versionUrl}`);
      }

      logger?.debug?.(`Resolved WebSocket URL: ${data.webSocketDebuggerUrl}`);
      return data.webSocketDebuggerUrl;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Timeout resolving WebSocket URL from ${versionUrl} (${timeoutMs / 1000}s)`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return url;
}
