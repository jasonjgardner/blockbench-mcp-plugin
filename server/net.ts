import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { Server as NetServer, Socket } from 'node:net'
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerToolsOnServer,
  registerResourcesOnServer,
  registerPromptsOnServer
} from '@/lib/factories'
import { createServer as createMcpServer } from '@/server/server'
import { sessionManager } from '@/lib/sessions'

export type { NetServer }

export type SessionTransports = Map<
  string,
  { transport: WebStandardStreamableHTTPServerTransport; server: McpServer }
>

function getStatusText (status: number): string {
  const texts: Record<number, string> = {
    200: 'OK',
    201: 'Created',
    204: 'No Content',
    400: 'Bad Request',
    404: 'Not Found',
    405: 'Method Not Allowed',
    409: 'Conflict',
    500: 'Internal Server Error'
  }
  return texts[status] || 'Unknown'
}

export default function createNetServer (
  {
    createServer
  }: { createServer: (callback: (socket: Socket) => void) => NetServer },
  {
    port,
    endpoint
  }: {
    endpoint: string
    port: number
    host?: string
  }
): [NetServer, SessionTransports] {
  const sessionTransports: SessionTransports = new Map()

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

        // Check endpoint - must match exactly or have query string/trailing content
        const pathWithoutQuery = path.split('?')[0]
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

          // If client provided a session ID but it's not found, reject with 409
          // This happens when the session timed out or was closed
          if (sessionId && !session) {
            console.log(
              `[MCP] Invalid session ID: ${sessionId.slice(0, 8)}... (session expired or not found)`
            )
            sendResponse(
              socket,
              409,
              { 'content-type': 'application/json' },
              JSON.stringify({
                jsonrpc: '2.0',
                error: {
                  code: -32600,
                  message: 'Session expired or not found. Please reconnect.'
                },
                id: null
              }),
              headers['connection']
            )
            continue
          }

          // If no session exists, create a new one with its own server and transport
          if (!session) {
            const sessionServer = createMcpServer()

            // Register all tools, resources, and prompts on this session's server
            registerToolsOnServer(sessionServer)
            registerResourcesOnServer(sessionServer)
            registerPromptsOnServer(sessionServer)

            const transport = new WebStandardStreamableHTTPServerTransport({
              sessionIdGenerator: () => crypto.randomUUID(),
              enableJsonResponse: true,
              onsessioninitialized: (newSessionId: string) => {
                console.log(
                  `[MCP] Session initialized: ${newSessionId.slice(0, 8)}...`
                )
                sessionManager.add(newSessionId)
                // Update the map with the actual session ID
                const sess = sessionTransports.get('__pending__')
                if (sess) {
                  sessionTransports.delete('__pending__')
                  sessionTransports.set(newSessionId, sess)

                  // Hook into oninitialized to capture client info
                  const underlyingServer = sess.server.server
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

            session = { transport, server: sessionServer }

            // Store with a temporary key if no session ID yet (will be updated in callback)
            if (!sessionId) {
              sessionTransports.set('__pending__', session)
            }
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

              try {
                while (true) {
                  // Check socket is still writable before each chunk
                  if (socketEnded || socket.destroyed || !socket.writable) break

                  const { done, value } = await reader.read()
                  if (done) break

                  const chunk = decoder.decode(value, { stream: true })
                  socket.write(chunk)
                }
              } catch (streamError) {
                console.error('[MCP] SSE stream error:', streamError)
              } finally {
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

      // Set connection header based on client request
      const keepAlive = connection?.toLowerCase() === 'keep-alive'
      headers['connection'] = keepAlive ? 'keep-alive' : 'close'

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
