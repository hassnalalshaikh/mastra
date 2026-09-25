/**
 * Framework-agnostic browser streaming module.
 *
 * This module provides the core logic for browser screencast streaming.
 * Server adapters (e.g., @mastra/hono) implement the WebSocket setup
 * and use these shared components.
 *
 * @example
 * ```typescript
 * import { ViewerRegistry, handleInputMessage } from '@mastra/server/browser-stream';
 *
 * const registry = new ViewerRegistry();
 *
 * // In your WebSocket handler:
 * ws.onopen = () => registry.addViewer(agentId, ws, getToolset);
 * ws.onclose = () => registry.removeViewer(agentId, ws);
 * ws.onmessage = (data) => handleInputMessage(data, getToolset, agentId);
 * ```
 */

export { ViewerRegistry } from './viewer-registry.js';
export { handleInputMessage } from './input-handler.js';
export {
  BROWSER_SOCKET_PROTOCOL,
  BROWSER_SOCKET_TOKEN_PREFIX,
  BROWSER_SOCKET_TOKEN_EXPIRED,
  openControllerBrowserSocket,
  readBrowserSocketProtocols,
} from '../handlers/agent-controller-browser-socket.js';
export type {
  BrowserSocketClientMessage,
  BrowserSocketServerMessage,
  BrowserSocketTransport,
  OpenControllerBrowserSocketArgs,
  OpenedControllerBrowserSocket,
} from '../handlers/agent-controller-browser-socket.js';
export type {
  StatusMessage,
  ErrorMessage,
  BrowserStreamConfig,
  MouseInputMessage,
  KeyboardInputMessage,
  ClientInputMessage,
  ViewportMessage,
  BrowserStreamWebSocket,
  BrowserStreamResult,
  ViewerRegistryLike,
} from './types.js';
