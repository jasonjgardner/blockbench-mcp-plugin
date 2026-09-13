import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { EmptyResultSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Server as NetServer, Socket } from 'node:net'
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerToolsOnServer,
  registerResourcesOnServer,
  registerPromptsOnServer
} from '@/lib/factories'
import { createServer as createMcpServer } from '@/server/server'
import { sessionManager, type ISessionConfig } from '@/lib/sessions'

export type { NetServer }

/**
 * Keep-alive configuration. Layered approach — TCP, HTTP, SSE, and MCP-level
 * pings each catch different classes of dead/stale connections.
 */
interface IKeepAliveConfig {
  /** Enable TCP keep-alive on accepted sockets */
  enabled: boolean
  /** Initial delay before sending first TCP keep-alive probe (ms) */
  initialDelay: number
  /**
   * Per-socket idle timeout (ms). If the socket sees no I/O for this long
   * it's destroyed at the OS level. 0 disables. Should exceed
   * sseHeartbeatIntervalMs and the session inactivity timeout to avoid
   * fighting application-level liveness.
   */
  idleTimeoutMs: number
  /**
   * Interval (ms) to write SSE comment heartbeats (`: keepalive\n\n`) during
   * a streaming response. Keeps connections alive through proxies/firewalls
   * that drop idle TCP. 0 disables.
   */
  sseHeartbeatIntervalMs: number
  /** Per-ping timeout (ms) for MCP-level server.ping() calls. */
  pingTimeoutMs: number
  /** HTTP Keep-Alive: timeout=N seconds advertised to clients. */
  httpKeepAliveTimeoutSec: number
}

const DEFAULT_KEEP_ALIVE: IKeepAliveConfig = {
  enabled: true,
  initialDelay: 30000,           // 30s before first TCP probe
  idleTimeoutMs: 10 * 60 * 1000, // 10min hard socket timeout
  sseHeartbeatIntervalMs: 15000, // 15s SSE comment heartbeat
  pingTimeoutMs: 5000,           // 5s MCP ping timeout
  httpKeepAliveTimeoutSec: 75    // matches typical browser/proxy defaults
}

export type SessionTransports = Map<
  string,
  { transport: WebStandardStreamableHTTPServerTransport; server: McpServer }
>

function getStatusText (status: number): string {
  const texts: Record<number, string> = {
    200: 'OK',
    201: 'Created',
    202: 'Accepted',
    204: 'No Content',
    400: 'Bad Request',
    404: 'Not Found',
    405: 'Method Not Allowed',
    409: 'Conflict',
    500: 'Internal Server Error'
  }
  return texts[status] || 'Unknown'
}

/**
 * Whether an HTTP request carries an MCP InitializeRequest. Only initialize
 * requests may create a new session — anything else without a session ID is
 * a client error, not a new connection. Per spec an InitializeRequest must
 * not be part of a JSON-RPC batch, so only a sole non-batched message counts.
 */
function isInitializeRequestBody (method: string, body: string): boolean {
  if (method !== 'POST' || !body) return false
  try {
    const parsed: unknown = JSON.parse(body)
    if (Array.isArray(parsed)) return false
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { method?: unknown }).method === 'initialize'
    )
  } catch {
    return false
  }
}

export default function createNetServer (
  {
    createServer
  }: { createServer: (callback: (socket: Socket) => void) => NetServer },
  {
    port,
    endpoint,
    keepAlive = DEFAULT_KEEP_ALIVE,
    sessionConfig
  }: {
    endpoint: string
    port: number
    host?: string
    keepAlive?: Partial<IKeepAliveConfig>
    sessionConfig?: Partial<ISessionConfig>
  }
): [NetServer, SessionTransports] {
  const sessionTransports: SessionTransports = new Map()
  const keepAliveConfig = { ...DEFAULT_KEEP_ALIVE, ...keepAlive }

  // Apply session configuration if provided
  if (sessionConfig) {
    sessionManager.configure(sessionConfig)
  }

  // Set up ping callback for session keep-alive.
  // Sends a real MCP ping request to the client to verify the connection is alive.
  sessionManager.setPingCallback(async (sessionId: string) => {
    const session = sessionTransports.get(sessionId)
    if (!session) return false

    try {
      // Send a JSON-RPC ping and wait for the client's response (pong).
      // Bounded by pingTimeoutMs: if the client has no open SSE stream, the
      // SDK silently drops server→client requests and the ping would
      // otherwise wait for the SDK's 60s default request timeout, stacking
      // pending pings.
      await session.server.server.request(
        { method: 'ping' },
        EmptyResultSchema,
        { timeout: keepAliveConfig.pingTimeoutMs }
      )
      return true
    } catch {
      // Ping was not answered — undeliverable (no SSE stream) or client gone.
      // Either way this is informational only; the inactivity timeout reaps.
      return false
    }
  })

  // Register callback to close transport when sessionManager removes a session (e.g., timeout)
  sessionManager.setRemovalCallback(async (sessionId: string) => {
    const session = sessionTransports.get(sessionId)
    if (session) {
      console.log(`[MCP] Closing transport for session: ${sessionId.slice(0, 8)}...`)
      try {
        await session.transport.close()
      } catch (error) {
        console.error('[MCP] Error closing transport:', error)
      } finally {
        sessionTransports.delete(sessionId)
      }
    }
  })

  const httpServer = createServer((socket: Socket) => {
    let buffer = Buffer.alloc(0)
    let socketEnded = false

    // Configure TCP keep-alive for connection health
    if (keepAliveConfig.enabled) {
      socket.setKeepAlive(true, keepAliveConfig.initialDelay)
    }

    // OS-level idle timeout: if no I/O happens for this long, kill the
    // socket. This catches half-open connections that TCP keep-alive misses
    // (e.g., NAT entries silently dropped by intermediaries).
    if (keepAliveConfig.idleTimeoutMs > 0) {
      socket.setTimeout(keepAliveConfig.idleTimeoutMs)
      socket.on('timeout', () => {
        if (!socket.destroyed) {
          console.log('[MCP] Socket idle timeout — closing connection')
          socket.destroy()
        }
      })
    }

    socket.on('data', (chunk: Buffer) => {
      if (socketEnded) return
      buffer = Buffer.concat([buffer, chunk])
      processHttpRequests().catch(err => {
        console.error('[MCP] Unhandled error in processHttpRequests:', err)
        // Try to send error response if socket is still writable
        if (!socket.destroyed) {
          try {
            sendResponse(
              socket,
              500,
              { 'content-type': 'application/json' },
              JSON.stringify({ error: 'Internal server error' }),
              undefined
            )
          } catch (sendErr) {
            console.error('[MCP] Failed to send error response:', sendErr)
            socket.destroy()
          }
        }
      })
    })

    socket.on('error', (err: Error) => {
      // ECONNRESET is common when clients disconnect abruptly - don't spam logs
      if (err.message !== 'read ECONNRESET') {
        console.error('[MCP] Socket error:', err.message)
      }
      // Clean up the socket
      socket.destroy()
    })

    socket.on('close', () => {
      // Clean up buffer when socket closes
      buffer = Buffer.alloc(0)
    })

    async function processHttpRequests () {
      while (true) {
        // Stop processing if socket is no longer writable
        if (socketEnded || socket.destroyed || !socket.writable) {
          return
        }

        // Look for end of HTTP headers
        const headerEnd = buffer.indexOf('\r\n\r\n')
        if (headerEnd === -1) return

        const headerSection = buffer.subarray(0, headerEnd).toString()
        const lines = headerSection.split('\r\n')
        const [method, path] = lines[0].split(' ')

        // Parse headers
        const headers: Record<string, string> = {}
        for (let i = 1; i < lines.length; i++) {
          const colonIdx = lines[i].indexOf(':')
          if (colonIdx > 0) {
            const key = lines[i].substring(0, colonIdx).trim().toLowerCase()
            const value = lines[i].substring(colonIdx + 1).trim()
            headers[key] = value
          }
        }

        // Calculate body boundaries
        const bodyStart = headerEnd + 4
        const contentLength = parseInt(headers['content-length'] || '0', 10)
        const requestEnd = bodyStart + contentLength

        // Wait for complete request body
        if (buffer.length < requestEnd) return

        const body = buffer.subarray(bodyStart, requestEnd).toString()
        buffer = buffer.subarray(requestEnd)

        // Build Web Standard Request
        const url = `http://localhost:${port}${path}`
        const webHeaders = new Headers()
        for (const [key, value] of Object.entries(headers)) {
          webHeaders.set(key, value)
        }

        const requestInit: RequestInit = {
          method,
          headers: webHeaders
        }

        // Add body for non-GET/HEAD requests
        if (method !== 'GET' && method !== 'HEAD' && body) {
          requestInit.body = body
        }

        const webRequest = new Request(url, requestInit)

        // Health check endpoint for monitoring
        const pathWithoutQuery = path.split('?')[0]
        if (pathWithoutQuery === '/health' || pathWithoutQuery === endpoint + '/health') {
          const healthStatus = {
            status: 'ok',
            timestamp: new Date().toISOString(),
            sessions: {
              active: sessionManager.getCount(),
              config: sessionManager.getConfig()
            }
          }
          sendResponse(
            socket,
            200,
            { 'content-type': 'application/json' },
            JSON.stringify(healthStatus),
            headers['connection']
          )
          continue
        }

        // Ready check endpoint (lighter weight than health)
        if (pathWithoutQuery === '/ready' || pathWithoutQuery === endpoint + '/ready') {
          sendResponse(
            socket,
            200,
            { 'content-type': 'application/json' },
            JSON.stringify({ ready: true }),
            headers['connection']
          )
          continue
        }

        // Check endpoint - must match exactly or have query string/trailing content
        if (
          pathWithoutQuery !== endpoint &&
          !path.startsWith(endpoint + '/') &&
          !path.startsWith(endpoint + '?')
        ) {
          sendResponse(
            socket,
            404,
            { 'content-type': 'text/plain' },
            'Not Found',
            headers['connection']
          )
          continue
        }

        try {
          // Get or create transport for this session
          const sessionId = headers['mcp-session-id']
          let session = sessionId ? sessionTransports.get(sessionId) : null

          // Per MCP spec, an unknown or expired session ID gets 404 Not Found,
          // signalling spec-compliant clients to transparently start a new
          // session with a fresh InitializeRequest. (409 is not in the spec
          // and leaves clients stuck until restart.)
          if (sessionId && !session) {
            console.log(
              `[MCP] Unknown session ID: ${sessionId.slice(0, 8)}... (session expired or not found)`
            )
            sendResponse(
              socket,
              404,
              { 'content-type': 'application/json' },
              JSON.stringify({
                jsonrpc: '2.0',
                error: {
                  code: -32001,
                  message: 'Session not found. Please reinitialize.'
                },
                id: null
              }),
              headers['connection']
            )
            continue
          }

          // Only an InitializeRequest may create a new session. Clients
          // (e.g., the SDK client inside mcp-remote) can send GETs,
          // notifications, or DELETEs without a session header while an
          // initialize is in flight — those must be rejected, not treated
          // as new connections.
          if (!session && !isInitializeRequestBody(method, body)) {
            sendResponse(
              socket,
              400,
              { 'content-type': 'application/json' },
              JSON.stringify({
                jsonrpc: '2.0',
                error: {
                  code: -32000,
                  message: 'Bad Request: Mcp-Session-Id header is required'
                },
                id: null
              }),
              headers['connection']
            )
            continue
          }

          // No session yet and this is an initialize request: create a new
          // session with its own server and transport
          if (!session) {
            const sessionServer = createMcpServer()

            // Register all tools, resources, and prompts on this session's server
            registerToolsOnServer(sessionServer)
            registerResourcesOnServer(sessionServer)
            registerPromptsOnServer(sessionServer)

            // Filled in below before handleRequest runs; onsessioninitialized
            // (fired during handleRequest) closes over this object, which
            // avoids a shared temporary map key that concurrent initialize
            // requests could clobber.
            const newSession = { server: sessionServer } as {
              transport: WebStandardStreamableHTTPServerTransport
              server: McpServer
            }

            const transport = new WebStandardStreamableHTTPServerTransport({
              sessionIdGenerator: () => crypto.randomUUID(),
              enableJsonResponse: true,
              onsessioninitialized: (newSessionId: string) => {
                console.log(
                  `[MCP] Session initialized: ${newSessionId.slice(0, 8)}...`
                )
                sessionManager.add(newSessionId)
                sessionTransports.set(newSessionId, newSession)

                // Hook into oninitialized to capture client info
                const underlyingServer = sessionServer.server
                underlyingServer.oninitialized = () => {
                  const clientInfo = underlyingServer.getClientVersion()
                  if (clientInfo) {
                    sessionManager.updateClientInfo(
                      newSessionId,
                      clientInfo.name,
                      clientInfo.version
                    )
                  }
                }
              },
              onsessionclosed: (closedSessionId: string) => {
                console.log(
                  `[MCP] Session closed: ${closedSessionId.slice(0, 8)}...`
                )
                // Delete from sessionTransports BEFORE calling sessionManager.remove()
                // to prevent the removal callback from trying to close an already-closing transport
                sessionTransports.delete(closedSessionId)
                sessionManager.remove(closedSessionId)
              }
            })

            // Connect this session's server to its transport
            await sessionServer.connect(transport)

            newSession.transport = transport
            session = newSession
          }

          // Update session activity
          if (sessionId) {
            sessionManager.updateActivity(sessionId)
          }

          // Let the transport handle the MCP protocol
          const webResponse = await session.transport.handleRequest(webRequest)

          // Convert Web Standard Response to HTTP
          const responseHeaders: Record<string, string> = {}
          webResponse.headers.forEach((value: string, key: string) => {
            responseHeaders[key] = value
          })

          const contentType = webResponse.headers.get('content-type') || ''

          // Ensure content-type is set for non-SSE responses (some clients require it)
          if (!contentType && webResponse.status !== 204) {
            responseHeaders['content-type'] = 'application/json'
          }

          // Handle SSE streams differently from regular responses
          if (contentType.includes('text/event-stream')) {
            // Send headers for SSE
            sendSSEHeaders(socket, webResponse.status, responseHeaders)

            // Stream the body
            if (webResponse.body) {
              const reader = webResponse.body.getReader()
              const decoder = new TextDecoder()

              // SSE heartbeat — write a comment line during silent periods so
              // proxies/firewalls/NAT don't drop the idle TCP connection.
              // Comments (`:`-prefixed lines) are ignored by SSE parsers.
              // We only emit when there's been no real chunk for the full
              // interval, to avoid splitting partial events.
              let lastChunkAt = Date.now()
              const heartbeatMs = keepAliveConfig.sseHeartbeatIntervalMs
              const heartbeat = heartbeatMs > 0
                ? setInterval(() => {
                    if (socketEnded || socket.destroyed || !socket.writable) return
                    if (Date.now() - lastChunkAt < heartbeatMs) return
                    try {
                      socket.write(': keepalive\n\n')
                      lastChunkAt = Date.now()
                    } catch (err) {
                      console.error('[MCP] SSE heartbeat write failed:', err)
                    }
                  }, heartbeatMs)
                : null

              try {
                while (true) {
                  // Check socket is still writable before each chunk
                  if (socketEnded || socket.destroyed || !socket.writable) break

                  const { done, value } = await reader.read()
                  if (done) break

                  const chunk = decoder.decode(value, { stream: true })
                  socket.write(chunk)
                  lastChunkAt = Date.now()
                }
              } catch (streamError) {
                console.error('[MCP] SSE stream error:', streamError)
              } finally {
                if (heartbeat) clearInterval(heartbeat)
                socketEnded = true
                socket.end()
              }
            } else {
              socketEnded = true
              socket.end()
            }
          } else {
            // Regular response
            const responseBody = await webResponse.text()
            sendResponse(
              socket,
              webResponse.status,
              responseHeaders,
              responseBody,
              headers['connection']
            )
          }
        } catch (error) {
          console.error('[MCP] Request handler error:', error)
          sendResponse(
            socket,
            500,
            { 'content-type': 'application/json' },
            JSON.stringify({ error: String(error) }),
            headers['connection']
          )
        }
      }
    }

    function sendSSEHeaders (
      sock: Socket,
      status: number,
      headers: Record<string, string>
    ): boolean {
      // Don't write to an already-ended socket
      if (socketEnded || sock.destroyed || !sock.writable) {
        return false
      }

      let response = `HTTP/1.1 ${status} ${getStatusText(status)}\r\n`

      // Remove content-length for SSE streams
      delete headers['content-length']

      // Ensure proper SSE headers
      headers['cache-control'] = 'no-cache'
      headers['connection'] = 'keep-alive'

      for (const [key, value] of Object.entries(headers)) {
        response += `${key}: ${value}\r\n`
      }
      response += '\r\n'

      sock.write(response)
      return true
    }

    function sendResponse (
      sock: Socket,
      status: number,
      headers: Record<string, string>,
      body: string,
      connection?: string
    ): boolean {
      // Don't write to an already-ended socket
      if (socketEnded || sock.destroyed || !sock.writable) {
        return false
      }

      let response = `HTTP/1.1 ${status} ${getStatusText(status)}\r\n`

      // Ensure required HTTP headers
      const bodyBytes = Buffer.byteLength(body)
      headers['content-length'] = bodyBytes.toString()

      // Set connection header based on client request. HTTP/1.1 defaults to
      // keep-alive unless the client explicitly opted out with `close`.
      const keepAlive = connection?.toLowerCase() !== 'close'
      headers['connection'] = keepAlive ? 'keep-alive' : 'close'

      // Tell the client how long we'll hold an idle connection. Helps clients
      // size their pools and avoid sending requests on a socket we're about
      // to close.
      if (keepAlive && keepAliveConfig.httpKeepAliveTimeoutSec > 0) {
        headers['keep-alive'] = `timeout=${keepAliveConfig.httpKeepAliveTimeoutSec}`
      }

      // Add Date header for HTTP/1.1 compliance
      if (!headers['date']) {
        headers['date'] = new Date().toUTCString()
      }

      for (const [key, value] of Object.entries(headers)) {
        response += `${key}: ${value}\r\n`
      }
      response += '\r\n'
      response += body

      // Write response and wait for it to be flushed before closing
      if (!keepAlive) {
        socketEnded = true
        // Use callback to ensure data is flushed before closing
        sock.write(response, () => {
          sock.end()
        })
      } else {
        sock.write(response)
      }

      return true
    }
  })

  httpServer.listen(port, () => {
    console.log(`[MCP] Server listening on http://localhost:${port}${endpoint}`)
  })

  httpServer.on('error', (err: Error) => {
    console.error('[MCP] Server error:', err)
    Blockbench.showQuickMessage(`MCP Server error: ${err.message}`, 3000)
  })

  return [httpServer, sessionTransports]
}
