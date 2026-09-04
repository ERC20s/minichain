import { createServer, IncomingMessage, Server, ServerResponse } from "http"
import { Socket } from "net"
import { Block, blockHash } from "../block"
import { Validator } from "../validators"

/**
 * A read-only JSON-RPC 2.0 HTTP surface over a running Node.
 *
 * The README and SPEC.md have advertised "JSON-RPC" since the first cycle and
 * nothing in the tree answered a question: eleven cycles hardened what a node
 * ACCEPTS (linkage, timestamps, Merkle root, transaction signatures, nonces,
 * balances, the header signature and the elected proposer) while the state all
 * of that maintains — the tip, the balance ledger, the nonce ledger, the staked
 * set — was reachable only from inside the process. A running node printed one
 * line at startup and was otherwise opaque.
 *
 * Two rules shape this module.
 *
 * READ ONLY. Every method here reads; none of them submits a transaction, a
 * block or a peer. That is deliberate, not an omission: src/node.ts is the ONE
 * place a block is judged, and an RPC that could inject one would be a second,
 * unauthenticated path around those checks. The surface talks to the node
 * through RpcNode below — four read accessors and nothing else — so a future
 * write method cannot be added here by accident, only on purpose.
 *
 * LOOPBACK BY DEFAULT. The server binds 127.0.0.1 unless a caller passes another
 * host, so starting a node does not put a new port on the public internet. There
 * is no authentication, no TLS and no rate limiting; anything wider than
 * loopback needs a reverse proxy in front of it.
 *
 * The transport is Node's built-in http — no new dependency:
 *  - POST only; any other verb answers 405 with an Allow header.
 *  - The body is capped at MAX_RPC_BODY_BYTES (64 KiB, the same bound the gossip
 *    transport puts on a payload, see MAX_PAYLOAD_HEX in src/gossip/ws.ts), and
 *    the cap is enforced on the declared Content-Length AND on the bytes as they
 *    arrive, so a lying header cannot make the node buffer megabytes.
 *  - Strict JSON-RPC 2.0 framing: jsonrpc must be exactly "2.0", method must be
 *    a string, id must be a string, a number, null or absent. A request with no
 *    id is a notification: every method is a pure read, so nothing is executed
 *    and the answer is 204 with no body.
 *  - Batch (array) requests are NOT supported in this cycle and are refused as
 *    an invalid request rather than half-handled.
 *  - HTTP status is 200 for a result, 400 for a malformed or unknown call, 405,
 *    413 and 500 for the transport-level failures; the JSON-RPC error object
 *    carries the real code either way.
 */

/** Default port for the RPC server, and the default the example runner uses. */
export const DEFAULT_RPC_PORT = 9310

/** Default bind address: loopback, so the surface is not exposed by default. */
export const DEFAULT_RPC_HOST = "127.0.0.1"

/**
 * Largest request body accepted, in bytes. 64 KiB — the same size the gossip
 * transport allows a payload (MAX_PAYLOAD_HEX is 131072 hex characters), which
 * is already far more than any call defined here needs.
 */
export const MAX_RPC_BODY_BYTES = 65536

/** JSON-RPC 2.0 error codes, as the specification defines them. */
export const RPC_PARSE_ERROR = -32700
export const RPC_INVALID_REQUEST = -32600
export const RPC_METHOD_NOT_FOUND = -32601
export const RPC_INVALID_PARAMS = -32602
export const RPC_INTERNAL_ERROR = -32603

/**
 * What the RPC surface is allowed to see of a Node.
 *
 * Structural on purpose: a Node satisfies it, and so does a hand-built fixture
 * in a test, but nothing here can reach gossip, broadcastBlock or the ledgers'
 * stage/commit. If a later cycle adds a write method it has to widen THIS
 * interface first, which is a visible change in a diff.
 */
export interface RpcNode {
  readonly tip: Block
  readonly validators: Validator[]
  readonly balances: { balanceOf(account: string): number }
  readonly nonces: { lastNonce(sender: string): number | undefined }
}

/** The handle startRpcServer returns. */
export interface RpcServerHandle {
  /** The port asked for; once listening, the port actually bound (port 0). */
  readonly port: number
  /** The address the server is bound to. */
  readonly host: string
  /** Resolves with the bound port once listening, rejects if the bind fails. */
  ready(): Promise<number>
  /** Stops listening and drops every open connection. */
  close(): Promise<void>
}

/** A failure with a JSON-RPC code attached; thrown by a method, never leaked. */
export class RpcError extends Error {
  readonly code: number
  readonly data?: unknown
  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = "RpcError"
    this.code = code
    this.data = data
  }
}

type JsonRpcId = string | number | null

interface JsonRpcErrorBody {
  code: number
  message: string
  data?: unknown
}

interface JsonRpcEnvelope {
  jsonrpc: "2.0"
  id: JsonRpcId
  result?: unknown
  error?: JsonRpcErrorBody
}

/** Shape of a tip as the RPC reports it. */
export interface RpcTip {
  hash: string
  parentHash: string
  height: number
  timestamp: number
  merkleRoot: string
  transactionCount: number
}

function resultEnvelope(id: JsonRpcId, result: unknown): JsonRpcEnvelope {
  return { jsonrpc: "2.0", id, result }
}

function errorEnvelope(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcEnvelope {
  const error: JsonRpcErrorBody = { code, message }
  if (data !== undefined) error.data = data
  return { jsonrpc: "2.0", id, error }
}

/** An HTTP status that matches a JSON-RPC code, for callers that look at it. */
function statusForCode(code: number): number {
  if (code === RPC_INTERNAL_ERROR) return 500
  return 400
}

/**
 * The single account argument the balance and nonce methods take, accepted
 * either by name ({"account": "..."}, or "sender"/"address" as aliases) or
 * positionally (["..."]). Anything else is an invalid-params error rather than
 * a silent lookup of "undefined".
 */
function accountParam(params: unknown): string {
  let value: unknown
  if (Array.isArray(params)) {
    if (params.length !== 1) {
      throw new RpcError(RPC_INVALID_PARAMS, "expected exactly one positional parameter: the account")
    }
    value = params[0]
  } else if (params && typeof params === "object") {
    const bag = params as Record<string, unknown>
    value =
      bag.account !== undefined ? bag.account : bag.sender !== undefined ? bag.sender : bag.address
  } else {
    throw new RpcError(
      RPC_INVALID_PARAMS,
      'params must be {"account": "<hex public key>"} or ["<hex public key>"]'
    )
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new RpcError(RPC_INVALID_PARAMS, "account must be a non-empty string")
  }
  return value
}

/** Methods with no parameters still refuse a parameter they cannot honour. */
function noParams(params: unknown, method: string): void {
  if (params === undefined || params === null) return
  if (Array.isArray(params) && params.length === 0) return
  if (typeof params === "object" && Object.keys(params as object).length === 0) return
  throw new RpcError(RPC_INVALID_PARAMS, `${method} takes no parameters`)
}

/** The tip as reported over RPC. blockHash covers the whole header (SPEC.md). */
function describeTip(tip: Block): RpcTip {
  return {
    hash: blockHash(tip),
    parentHash: tip.parentHash,
    height: tip.height,
    timestamp: tip.timestamp,
    merkleRoot: tip.merkleRoot,
    transactionCount: Array.isArray(tip.transactions) ? tip.transactions.length : 0,
  }
}

type RpcMethod = (node: RpcNode, params: unknown) => unknown

/**
 * The whole surface. Every entry reads; adding one that writes means changing
 * RpcNode above, which is the point.
 */
export const RPC_METHODS: Readonly<Record<string, RpcMethod>> = Object.freeze({
  /** The height of this node's current tip. */
  chain_height: (node: RpcNode, params: unknown) => {
    noParams(params, "chain_height")
    return { height: node.tip.height }
  },

  /** The current tip's identity and header fields. */
  chain_tip: (node: RpcNode, params: unknown) => {
    noParams(params, "chain_tip")
    return describeTip(node.tip)
  },

  /** The committed balance of an account; an account never credited holds 0. */
  chain_getBalance: (node: RpcNode, params: unknown) => {
    const account = accountParam(params)
    return { account, balance: node.balances.balanceOf(account) }
  },

  /**
   * The last nonce accepted for a sender, or null when this node has seen none.
   * null and 0 are different answers: 0 means a nonce-0 transaction landed.
   */
  chain_getNonce: (node: RpcNode, params: unknown) => {
    const account = accountParam(params)
    const last = node.nonces.lastNonce(account)
    return { account, nonce: last === undefined ? null : last }
  },

  /** The staked set this node enforces. Empty = the permissive path. */
  chain_validators: (node: RpcNode, params: unknown) => {
    noParams(params, "chain_validators")
    const validators = (node.validators || []).map((v) => ({
      publicKey: v.publicKey,
      stake: v.stake,
    }))
    const totalStake = validators.reduce((sum, v) => sum + (Number(v.stake) || 0), 0)
    return { validators, totalStake, enforced: validators.length > 0 }
  },
})

/** The method names this server answers, for documentation and tests. */
export const RPC_METHOD_NAMES: string[] = Object.keys(RPC_METHODS)

function sendJson(res: ServerResponse, status: number, body: JsonRpcEnvelope): void {
  const text = JSON.stringify(body)
  const bytes = Buffer.from(text, "utf8")
  if (res.writableEnded) return
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(bytes.length),
    "Cache-Control": "no-store",
  })
  res.end(bytes)
}

/**
 * Framing, dispatch and the error mapping for one request body.
 *
 * Every failure below answers with a JSON-RPC error object; nothing throws out
 * of here, so a hostile body cannot take the process down with it.
 */
function respond(node: RpcNode, body: string, res: ServerResponse): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (e) {
    sendJson(res, 400, errorEnvelope(null, RPC_PARSE_ERROR, "invalid JSON in request body"))
    return
  }

  if (Array.isArray(parsed)) {
    sendJson(
      res,
      400,
      errorEnvelope(null, RPC_INVALID_REQUEST, "batch requests are not supported")
    )
    return
  }
  if (!parsed || typeof parsed !== "object") {
    sendJson(res, 400, errorEnvelope(null, RPC_INVALID_REQUEST, "request must be a JSON object"))
    return
  }

  const req = parsed as Record<string, unknown>

  // id first: an error still has to be addressed to the right call.
  const rawId = req.id
  let id: JsonRpcId = null
  const isNotification = rawId === undefined
  if (!isNotification) {
    if (rawId === null || typeof rawId === "string" || typeof rawId === "number") {
      id = rawId as JsonRpcId
    } else {
      sendJson(
        res,
        400,
        errorEnvelope(null, RPC_INVALID_REQUEST, "id must be a string, a number or null")
      )
      return
    }
  }

  if (req.jsonrpc !== "2.0") {
    sendJson(res, 400, errorEnvelope(id, RPC_INVALID_REQUEST, 'jsonrpc must be exactly "2.0"'))
    return
  }
  if (typeof req.method !== "string" || req.method.length === 0) {
    sendJson(res, 400, errorEnvelope(id, RPC_INVALID_REQUEST, "method must be a non-empty string"))
    return
  }
  if (
    req.params !== undefined &&
    req.params !== null &&
    typeof req.params !== "object"
  ) {
    sendJson(
      res,
      400,
      errorEnvelope(id, RPC_INVALID_PARAMS, "params must be an object, an array or absent")
    )
    return
  }

  const method = Object.prototype.hasOwnProperty.call(RPC_METHODS, req.method)
    ? RPC_METHODS[req.method]
    : undefined
  if (!method) {
    sendJson(
      res,
      400,
      errorEnvelope(id, RPC_METHOD_NOT_FOUND, `unknown method: ${req.method}`, {
        methods: RPC_METHOD_NAMES,
      })
    )
    return
  }

  // A notification asks for no answer. Every method is a pure read, so there is
  // nothing worth running for its side effects: acknowledge and stop.
  if (isNotification) {
    if (!res.writableEnded) {
      res.writeHead(204, { "Cache-Control": "no-store" })
      res.end()
    }
    return
  }

  try {
    const result = method(node, req.params)
    sendJson(res, 200, resultEnvelope(id, result))
  } catch (e) {
    if (e instanceof RpcError) {
      sendJson(res, statusForCode(e.code), errorEnvelope(id, e.code, e.message, e.data))
      return
    }
    // Anything else is this node's fault, not the caller's — a
    // CanonicalEncodingError out of blockHash, say. The message is kept
    // generic; the node's own logs are where a detail belongs.
    sendJson(res, 500, errorEnvelope(id, RPC_INTERNAL_ERROR, "internal error"))
  }
}

function handleRequest(node: RpcNode, req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST")
    sendJson(
      res,
      405,
      errorEnvelope(
        null,
        RPC_INVALID_REQUEST,
        "this is a JSON-RPC 2.0 endpoint; POST a request object"
      )
    )
    return
  }

  // The declared length first: a caller ANNOUNCING more than the cap has already
  // lost, and nothing it sends is buffered.
  const declared = Number(req.headers["content-length"])
  const chunks: Buffer[] = []
  let size = 0
  let refused = Number.isFinite(declared) && declared > MAX_RPC_BODY_BYTES
  let dead = false

  req.on("data", (chunk: Buffer) => {
    if (dead) return
    size += chunk.length
    if (refused) {
      // The rest of an over-long body is read and DROPPED rather than answered
      // with a socket reset: a client that is still writing when the limit is
      // hit should get the 413 it earned, not a connection error. Nothing is
      // kept, so this costs a counter and no memory...
      if (size > MAX_RPC_BODY_BYTES * 8) {
        // ...up to a point. A peer that keeps streaming after the refusal is
        // not a client with a big request, and the connection goes.
        dead = true
        req.destroy()
      }
      return
    }
    // The bytes as they arrive, so a lying or absent Content-Length (a chunked
    // body) cannot get past the cap either.
    if (size > MAX_RPC_BODY_BYTES) {
      refused = true
      chunks.length = 0
      return
    }
    chunks.push(chunk)
  })

  req.on("end", () => {
    if (dead) return
    if (refused) {
      sendJson(
        res,
        413,
        errorEnvelope(null, RPC_INVALID_REQUEST, `request body exceeds ${MAX_RPC_BODY_BYTES} bytes`)
      )
      return
    }
    try {
      respond(node, Buffer.concat(chunks).toString("utf8"), res)
    } catch (e) {
      sendJson(res, 500, errorEnvelope(null, RPC_INTERNAL_ERROR, "internal error"))
    }
  })

  // A connection that dies mid-body is not an event worth logging.
  req.on("error", () => {
    dead = true
  })
}

/**
 * Start the read-only JSON-RPC server for `node`.
 *
 * Binds loopback unless `host` says otherwise. Pass port 0 to let the operating
 * system pick a free port and read it back from ready(), which is what the tests
 * do so they never collide with the gossip ports.
 */
export function startRpcServer(
  node: RpcNode,
  port: number = DEFAULT_RPC_PORT,
  host: string = DEFAULT_RPC_HOST
): RpcServerHandle {
  const sockets: Set<Socket> = new Set()
  const server: Server = createServer((req, res) => {
    try {
      handleRequest(node, req, res)
    } catch (e) {
      sendJson(res, 500, errorEnvelope(null, RPC_INTERNAL_ERROR, "internal error"))
    }
  })

  server.on("connection", (socket: Socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    socket.on("error", () => sockets.delete(socket))
  })

  let bound = port
  let fail: ((err: Error) => void) | null = null

  const listening = new Promise<number>((resolve, reject) => {
    fail = reject
    server.once("listening", () => {
      fail = null
      const address = server.address()
      if (address && typeof address === "object") bound = address.port
      resolve(bound)
    })
    server.listen(port, host)
  })
  // A bind failure is reported through ready(); a caller that never asks must
  // not bring the process down with an unhandled rejection.
  listening.catch(() => {})

  // Permanent: without it a later server 'error' event is unhandled and throws.
  server.on("error", (err: Error) => {
    if (fail) {
      const reject = fail
      fail = null
      reject(err)
    }
  })

  return {
    get port() {
      return bound
    },
    host,
    ready: () => listening,
    close: () =>
      new Promise<void>((resolve) => {
        // Keep-alive sockets keep server.close() waiting, so they are dropped
        // here: this handle is stopped on shutdown and between tests.
        for (const socket of sockets) {
          try {
            socket.destroy()
          } catch (e) {}
        }
        sockets.clear()
        try {
          server.close(() => resolve())
        } catch (e) {
          resolve()
        }
      }),
  }
}
