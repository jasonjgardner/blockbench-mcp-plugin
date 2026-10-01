import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { EmptyResultSchema, type RequestId } from '@modelcontextprotocol/sdk/types.js'
import type { Server as NetServer, Socket } from 'node:net'
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerToolsOnServer,
  registerResourcesOnServer,
  registerPromptsOnServer,
  refreshToolAvailability
} from '@/lib/factories'
import { createServer as createMcpServer } from '@/server/server'
import { sessionManager, type ISessionConfig } from '@/lib/sessions'
import { checkRequest, formatHostForUrl, resolveListenPlan } from '@/server/net-security'

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

interface ISessionEntry {
  transport: WebStandardStreamableHTTPServerTransport
  server: McpServer
  /** Set once the transport closes (DELETE, inactivity timeout, unload). */
  closed: boolean
  /** Requests waiting for a response; each is answered when the transport closes first. */
  waiting: Set<() => void>
  /** Open SSE response streams. A session with none and no waiting request is idle. */
  streams: number
}

export type SessionTransports = Map<string, ISessionEntry>

function getStatusText (status: number): string {
  const texts: Record<number, string> = {
    200: 'OK',
    201: 'Created',
    202: 'Accepted',
    204: 'No Content',
    400: 'Bad Request',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    406: 'Not Acceptable',
    409: 'Conflict',
    413: 'Payload Too Large',
    415: 'Unsupported Media Type',
    500: 'Internal Server Error',
    501: 'Not Implemented',
    503: 'Service Unavailable'
  }
  return texts[status] || 'Unknown'
}

/** Largest request body accepted; larger requests are refused before being buffered. */
const MAX_BODY_BYTES = 16 * 1024 * 1024

/** Bytes a connection may queue while its current request is answered: about one more request. */
const MAX_QUEUED_BYTES = MAX_BODY_BYTES + 64 * 1024

/**
 * Validates the framing headers of one request. `Content-Length` must be
 * plain digits: `parseInt` accepts "x" (NaN) and negative values, which made
 * the parser answer the same request forever and freeze Blockbench. Chunked
 * bodies are not decoded by this parser, so they are refused instead of being
 * read as a second request.
 *
 * @returns The body length, or the status and reason to refuse with.
 */
export function readBodyLength (headers: Record<string, string>): { length: number } | { status: number, reason: string } {
  if (headers['transfer-encoding'] !== undefined) {
    return { status: 501, reason: 'Transfer-Encoding is not supported; send a Content-Length body' }
  }
  const raw = headers['content-length']
  if (raw === undefined || raw === '') return { length: 0 }
  if (!/^\d+$/.test(raw)) {
    return { status: 400, reason: `Invalid Content-Length "${raw.slice(0, 32)}"` }
  }
  const length = Number(raw)
  if (length > MAX_BODY_BYTES) {
    return { status: 413, reason: `Body of ${length} bytes exceeds the ${MAX_BODY_BYTES}-byte limit` }
  }
  return { length }
}

/** JSON-RPC error code for a request the client cancelled (LSP's RequestCancelled; MCP defines none). */
const REQUEST_CANCELLED = -32800

/**
 * Answers a request whose handler the SDK aborted on `notifications/cancelled`.
 * MCP says a receiver SHOULD NOT answer a cancelled request, and the SDK sends
 * nothing; but in JSON response mode the POST that carried the request stays
 * open until every request in it is answered, so it would never close and its
 * stream mapping would stay in the transport. The error closes the exchange;
 * the client that cancelled ignores it. Only aborted handlers get here: the SDK
 * ignores some cancellations (a falsy `requestId` such as 0, a malformed
 * `reason`), and a request that already answered keeps its result.
 */
function answerCancelled (server: McpServer, requestId: RequestId): void {
  server.server.transport
    ?.send({
      jsonrpc: '2.0',
      id: requestId,
      error: { code: REQUEST_CANCELLED, message: 'Request cancelled by the client' }
    })
    .catch(() => undefined)
}

/** Marks `session` closed and releases its waiting requests when the transport closes. */
function trackClose (session: ISessionEntry): void {
  const onclose = session.transport.onclose
  session.transport.onclose = () => {
    onclose?.()
    session.closed = true
    for (const release of session.waiting) release()
    session.waiting.clear()
  }
}

/** Answer for a request whose session closed before the transport produced a response. */
function sessionClosedResponse (): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Session closed before the request completed. Please reinitialize.' },
      id: null
    }),
    { status: 404, headers: { 'content-type': 'application/json' } }
  )
}

/**
 * Waits for the transport's answer to a POST. A JSON response waits for every
 * answer, and the SDK never resolves it once the transport closes (DELETE from
 * another connection, inactivity timeout), so the POST is answered instead of
 * hanging.
 */
function awaitPostResponse (session: ISessionEntry, pending: Promise<Response>): Promise<Response> {
  if (session.closed) return Promise.resolve(sessionClosedResponse())
  return new Promise((resolve, reject) => {
    const release = (): void => resolve(sessionClosedResponse())
    session.waiting.add(release)
    pending.then(resolve, reject).finally(() => session.waiting.delete(release))
  })
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
    if (Array.isArray(parsed) || typeof parsed !== 'object' || parsed === null) return false
    const { method, id } = parsed as { method?: unknown, id?: unknown }
    // Without an id it is a notification: the transport would open a session,
    // answer 202 without its id, and the slot could never be freed.
    return method === 'initialize' && (typeof id === 'string' || typeof id === 'number')
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
    host,
    keepAlive = DEFAULT_KEEP_ALIVE,
    sessionConfig
  }: {
    endpoint: string
    port: number
    /** `mcp_host` setting; empty or `localhost` listens on 127.0.0.1 and ::1 only. */
    host?: string
    keepAlive?: Partial<IKeepAliveConfig>
    sessionConfig?: Partial<ISessionConfig>
  }
): [NetServer[], SessionTransports] {
  const sessionTransports: SessionTransports = new Map()
  const keepAliveConfig = { ...DEFAULT_KEEP_ALIVE, ...keepAlive }
  const listenPlan = resolveListenPlan(host)
  /** New sessions whose initialize request is still being handled. */
  const opening = new Set<ISessionEntry>()

  // Apply session configuration if provided
  if (sessionConfig) {
    sessionManager.configure(sessionConfig)
  }

  /** Open sessions plus initialize requests that will open one; the manager already counts initialized ones. */
  const sessionCount = (): number =>
    sessionManager.getCount() + [...opening].filter((entry) => entry.transport.sessionId === undefined).length

  /**
   * Ends a new session's handling. An initialize the transport refused (wrong
   * Accept or Content-Type, invalid JSON-RPC) leaves it without a session id,
   * so no later request can reach it: close its server instead of leaving it
   * connected and tracked by the tool and resource registries.
   */
  async function finishOpening (entry: ISessionEntry): Promise<void> {
    opening.delete(entry)
    if (entry.transport.sessionId !== undefined) return
    try {
      await entry.server.close()
    } catch (error) {
      console.error('[MCP] Error closing an unused session server:', error)
    }
  }

  /**
   * Makes room at the session limit by closing the least recently active
   * session with no request in flight. A client that restarts without a
   * DELETE leaves its session open until the inactivity timeout, which would
   * lock new clients out for that long.
   *
   * @returns Whether a session was closed.
   */
  function evictIdleSession (): boolean {
    const [oldest] = [...sessionTransports.entries()]
      .filter(([, entry]) => entry.waiting.size === 0 && entry.streams === 0)
      .map(([id]) => ({ id, lastActivity: sessionManager.get(id)?.lastActivity.getTime() ?? 0 }))
      .sort((a, b) => a.lastActivity - b.lastActivity)
    if (!oldest) return false
    console.warn(`[MCP] Session limit reached: closing the least recently active idle session ${oldest.id.slice(0, 8)}... for a new client`)
    sessionManager.remove(oldest.id)
    return true
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

  const onConnection = (socket: Socket): void => {
    let buffer = Buffer.alloc(0)
    let socketEnded = false
    /** `processHttpRequests` is running; it reads bytes that arrive meanwhile once its request is answered. */
    let processing = false

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
      // One loop per connection: a request that arrives while another is still
      // being answered (HTTP pipelining) must wait, or a second loop would
      // answer it first and the responses would come out of order.
      if (processing) {
        if (buffer.length > MAX_QUEUED_BYTES) socket.destroy()
        return
      }
      processing = true
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
      }).finally(() => {
        processing = false
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

        // Calculate body boundaries; malformed framing closes the connection
        const bodyStart = headerEnd + 4
        const framing = readBodyLength(headers)
        if ('status' in framing) {
          console.warn(`[MCP] Rejected request: ${framing.reason}`)
          buffer = Buffer.alloc(0)
          sendResponse(
            socket,
            framing.status,
            { 'content-type': 'application/json' },
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32600, message: framing.reason },
              id: null
            }),
            'close'
          )
          return
        }
        const contentLength = framing.length
        const requestEnd = bodyStart + contentLength

        // Wait for complete request body
        if (buffer.length < requestEnd) return

        const body = buffer.subarray(bodyStart, requestEnd).toString()
        buffer = buffer.subarray(requestEnd)

        // Refuse requests another website could send through the user's browser
        // (cross-origin pages and DNS rebinding) before any routing happens.
        const check = checkRequest(headers, listenPlan)
        if (!check.allowed) {
          console.warn(`[MCP] Rejected request: ${check.reason}`)
          sendResponse(
            socket,
            403,
            { 'content-type': 'application/json' },
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32000, message: `Forbidden: ${check.reason}` },
              id: null
            }),
            headers['connection']
          )
          continue
        }

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
          let created: ISessionEntry | undefined
          if (!session) {
            const { maxSessions } = sessionManager.getConfig()
            if (sessionCount() >= maxSessions && !evictIdleSession()) {
              console.warn(`[MCP] Refused initialize: ${maxSessions} sessions are open and all are in use`)
              sendResponse(
                socket,
                503,
                { 'content-type': 'application/json' },
                JSON.stringify({
                  jsonrpc: '2.0',
                  error: {
                    code: -32000,
                    message: `Too many MCP sessions: ${maxSessions} are open and all are in use. Close an unused client and retry.`
                  },
                  id: null
                }),
                headers['connection']
              )
              continue
            }

            const sessionServer = createMcpServer({
              onRequestCancelled: (requestId) => answerCancelled(sessionServer, requestId)
            })

            // Register all tools, resources, and prompts on this session's server
            registerToolsOnServer(sessionServer)
            registerResourcesOnServer(sessionServer)
            registerPromptsOnServer(sessionServer)

            // onsessioninitialized (fired during handleRequest) closes over
            // `newSession`, created right below, which avoids a shared
            // temporary map key that concurrent initialize requests could clobber.
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

            const newSession: ISessionEntry = { transport, server: sessionServer, closed: false, waiting: new Set(), streams: 0 }
            // Counted toward the limit from now on, so concurrent initialize requests cannot overshoot it.
            opening.add(newSession)
            created = newSession

            // Connect this session's server to its transport
            try {
              await sessionServer.connect(transport)
            } catch (error) {
              await finishOpening(newSession)
              throw error
            }
            trackClose(newSession)
            session = newSession
          }

          // Update session activity
          if (sessionId) {
            sessionManager.updateActivity(sessionId)
          }

          // Let the transport handle the MCP protocol
          refreshToolAvailability()
          let webResponse: Response
          try {
            const pending = session.transport.handleRequest(webRequest)
            webResponse = method === 'POST' ? await awaitPostResponse(session, pending) : await pending
          } finally {
            if (created) await finishOpening(created)
          }

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

              // A dropped connection must cancel the stream: the SDK only
              // frees a session's single GET stream on cancel, so a reader left
              // pending makes every reconnect fail with 409 and silently drops
              // list_changed notifications for the rest of the session.
              const cancelStream = (): void => {
                reader.cancel().catch(() => undefined)
              }
              socket.once('close', cancelStream)

              session.streams++
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
                session.streams--
                socket.off('close', cancelStream)
                if (heartbeat) clearInterval(heartbeat)
                cancelStream()
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
  }

  // One listener per address. Without a host, Node would listen on every
  // interface and let other computers on the network drive Blockbench.
  const httpServers = listenPlan.hosts.map((listenHost) => {
    // `close()` only stops new connections; open keep-alive sockets would keep
    // running this (possibly unloaded) code. Track them and destroy them on close.
    const openSockets = new Set<Socket>()
    const httpServer = createServer((socket: Socket) => {
      openSockets.add(socket)
      socket.once('close', () => openSockets.delete(socket))
      onConnection(socket)
    })
    const closeListener = httpServer.close.bind(httpServer)
    httpServer.close = ((callback?: (err?: Error) => void) => {
      closeListener(callback)
      for (const socket of openSockets) socket.destroy()
      openSockets.clear()
      return httpServer
    }) as typeof httpServer.close

    httpServer.on('error', (err: NodeJS.ErrnoException) => {
      // IPv6 may be disabled; the 127.0.0.1 listener still serves `localhost`.
      const ipv6LoopbackUnavailable =
        listenPlan.hosts.length > 1 &&
        listenHost === '::1' &&
        (err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT')
      if (ipv6LoopbackUnavailable) {
        console.warn('[MCP] IPv6 loopback (::1) unavailable; listening on 127.0.0.1 only')
        return
      }
      console.error('[MCP] Server error:', err)
      Blockbench.showQuickMessage(`MCP Server error: ${err.message}`, 3000)
    })

    httpServer.listen(port, listenHost, () => {
      const bound = httpServer.address()
      const boundPort = typeof bound === 'object' && bound ? bound.port : port
      console.log(
        `[MCP] Server listening on http://${formatHostForUrl(listenHost)}:${boundPort}${endpoint}`
      )
    })

    return httpServer
  })

  if (!listenPlan.loopbackOnly) {
    console.warn(
      `[MCP] mcp_host is "${host}": other computers can connect. ` +
        `Anyone who can reach port ${port} can control Blockbench.`
    )
  }

  return [httpServers, sessionTransports]
}
