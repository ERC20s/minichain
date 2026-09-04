import { createServer, IncomingMessage, Server, ServerResponse } from "http"
import { Socket } from "net"
import { Block, blockHash } from "../block"
import { MempoolResult } from "../state/mempool"
import { Transaction } from "../types/transaction"
import { Validator } from "../validators"

/**
 * A JSON-RPC 2.0 HTTP surface over a running Node: every read this node can
 * answer, plus ONE write — chain_sendTransaction — served on loopback only.
 *
 * The README and SPEC.md have advertised "JSON-RPC" since the first cycle and
 * nothing in the tree answered a question: eleven cycles hardened what a node
 * ACCEPTS (linkage, timestamps, Merkle root, transaction signatures, nonces,
 * balances, the header signature and the elected proposer) while the state all
 * of that maintains — the tip, the balance ledger, the nonce ledger, the staked
 * set — was reachable only from inside the process. A running node printed one
 * line at startup and was otherwise opaque.
 *
 * Three rules shape this module.
 *
 * READS ARE FREE, AND THERE IS EXACTLY ONE WRITE. Every method in RPC_METHODS
 * reads. RPC_WRITE_METHODS holds the single method that does not, and what it
 * does is deliberately narrow: it hands a SIGNED transaction to
 * Node.submitTransaction, which is the same pool path a gossiped "tx" frame
 * takes — the ed25519 transaction signature, a nonce strictly above the sender's
 * committed nonce, and a balance that covers the amount. It cannot submit a
 * BLOCK, move the tip or write a ledger: src/node.ts stays the ONE place a block
 * is judged, and the surface still talks to the node through RpcNode below, so
 * widening it any further is a visible change in a diff.
 *
 * LOOPBACK BY DEFAULT, AND WRITES ONLY THERE. The server binds 127.0.0.1 unless
 * a caller passes another host, so starting a node does not put a new port on
 * the public internet. There is no authentication, no TLS and no rate limiting,
 * so the write method is served ONLY when the bind address is a loopback
 * address: widening the bind (for a reverse proxy, say) silently turns
 * chain_sendTransaction off rather than silently opening a write port to the
 * world. On a non-loopback bind the method answers -32601 with
 * data.reason "not-loopback"; a node with no submitTransaction answers -32601
 * with data.reason "unsupported".
 *
 * The transport is Node's built-in http — no new dependency:
 *  - POST only; any other verb answers 405 with an Allow header.
 *  - The body is capped at MAX_RPC_BODY_BYTES (64 KiB, the same bound the gossip
 *    transport puts on a payload, see MAX_PAYLOAD_HEX in src/gossip/ws.ts), and
 *    the cap is enforced on the declared Content-Length AND on the bytes as they
 *    arrive, so a lying header cannot make the node buffer megabytes.
 *  - Strict JSON-RPC 2.0 framing: jsonrpc must be exactly "2.0", method must be
 *    a string, id must be a string, a number, null or absent. A request with no
 *    id is a notification: a read has no effect worth running for, so nothing is
 *    executed, while the write method IS executed (its point is the effect) and
 *    its answer discarded. Either way the answer is 204 with no body.
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

/**
 * How many pending transaction ids chain_mempool lists at most. A full pool
 * (MAX_MEMPOOL = 1024 in src/state/mempool.ts) would otherwise answer with 64 KiB
 * of hex; the `size` field always reports the true total and `truncated` says the
 * list was cut.
 */
export const RPC_MEMPOOL_MAX_IDS = 256

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
 * in a test, but nothing here can reach gossip, broadcastBlock, acceptBlock,
 * proposeBlock or the ledgers' stage/commit. Adding a write method means
 * widening THIS interface first, which is a visible change in a diff — as
 * submitTransaction below is.
 */
export interface RpcNode {
  readonly tip: Block
  readonly validators: Validator[]
  readonly balances: { balanceOf(account: string): number }
  readonly nonces: { lastNonce(sender: string): number | undefined }
  /**
   * The pending-transaction pool, when the node has one (src/state/mempool.ts).
   *
   * OPTIONAL and read-only: `size` and `ids()` are all this surface can see, so
   * chain_mempool can report what is queued and can never admit, relay or
   * remove anything. A fixture without a pool still satisfies RpcNode and
   * chain_mempool answers `enabled: false` for it.
   */
  readonly mempool?: { readonly size: number; ids(): string[] }
  /**
   * Offer a signed transaction to this node (Node.submitTransaction).
   *
   * The ONLY write this surface has, and it writes nothing itself: the node
   * applies the ordinary pool rules — signature, nonce, balance, the caps — and
   * relays only what it admits, so an RPC caller gets exactly what a peer
   * gossiping the same bytes would get, including the refusal reason. It cannot
   * touch the tip: a pooled transaction reaches the chain only when an elected
   * proposer mints it and acceptBlock judges the block.
   *
   * OPTIONAL: a fixture without it still satisfies RpcNode, and
   * chain_sendTransaction answers -32601 (data.reason "unsupported") for it.
   */
  readonly submitTransaction?: (tx: Transaction) => MempoolResult
}

/** The handle startRpcServer returns. */
export interface RpcServerHandle {
  /** The port asked for; once listening, the port actually bound (port 0). */
  readonly port: number
  /** The address the server is bound to. */
  readonly host: string
  /**
   * Whether this server serves the write method: true only for a loopback bind
   * of a node that has submitTransaction. The runner logs it.
   */
  readonly writesEnabled: boolean
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

/**
 * The transaction argument chain_sendTransaction takes, accepted either by name
 * ({"transaction": {...}}, or "tx"/"signedTransaction" as aliases) or
 * positionally ([{...}]).
 *
 * Shape only: anything that is not a single JSON object is -32602, because it is
 * the CALLER's mistake. Everything about the transaction itself — the signature,
 * the sender, the nonce, the amount — is judged by the mempool, whose refusal is
 * a result, not an error: the caller asked a well-formed question and the answer
 * is "no, and here is why".
 */
function transactionParam(params: unknown): Transaction {
  let value: unknown
  if (Array.isArray(params)) {
    if (params.length !== 1) {
      throw new RpcError(
        RPC_INVALID_PARAMS,
        "expected exactly one positional parameter: the signed transaction"
      )
    }
    value = params[0]
  } else if (params && typeof params === "object") {
    const bag = params as Record<string, unknown>
    value =
      bag.transaction !== undefined
        ? bag.transaction
        : bag.tx !== undefined
        ? bag.tx
        : bag.signedTransaction
  } else {
    throw new RpcError(
      RPC_INVALID_PARAMS,
      'params must be {"transaction": {...}} or [{...}] — a signed transaction object'
    )
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RpcError(RPC_INVALID_PARAMS, "transaction must be a JSON object")
  }
  return value as Transaction
}

/**
 * Is this bind address a loopback address?
 *
 * The write method is served only when it is. IPv4 loopback is the whole
 * 127.0.0.0/8 block, not just 127.0.0.1; "localhost", "::1" (in any spelling,
 * with or without brackets) and the IPv4-mapped form count too. Anything this
 * cannot positively recognise — a public address, "0.0.0.0", "::", a hostname —
 * is NOT loopback, which is the safe direction to be wrong in.
 */
export function isLoopbackHost(host: string): boolean {
  if (typeof host !== "string") return false
  const h = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "")
  if (h === "localhost") return true
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true
  if (h === "::ffff:127.0.0.1") return true
  return /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(h)
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
 * The READ surface. Every entry here reads and nothing else — the audit is the
 * table. A method that writes goes in RPC_WRITE_METHODS below, where the
 * loopback rule applies to it.
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

  /**
   * What this node has pending but not yet in a block.
   *
   * Reads only: the size, and up to RPC_MEMPOOL_MAX_IDS transaction ids in
   * admission order (an id is the hex sha256 of the transaction's Merkle leaf,
   * see src/state/mempool.ts). `truncated` says the pool holds more than the
   * listed ids. A node built without a pool answers enabled: false rather than
   * an error, so the method is safe to poll against any node.
   */
  chain_mempool: (node: RpcNode, params: unknown) => {
    noParams(params, "chain_mempool")
    const pool = node.mempool
    if (!pool) return { enabled: false, size: 0, pending: [] as string[], truncated: false }
    const all = pool.ids() || []
    const pending = all.slice(0, RPC_MEMPOOL_MAX_IDS)
    return {
      enabled: true,
      size: pool.size,
      pending,
      truncated: all.length > pending.length,
    }
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

/** The READ method names, for documentation and tests. */
export const RPC_METHOD_NAMES: string[] = Object.keys(RPC_METHODS)

/**
 * The write surface: one method, served only on a loopback bind.
 *
 * It is a separate table from RPC_METHODS on purpose. The read table can be
 * audited at a glance ("nothing here writes") and every write this chain ever
 * grows has to be added HERE, where the loopback rule and this comment apply to
 * it. A block is still not submittable by any of them.
 */
export const RPC_WRITE_METHODS: Readonly<Record<string, RpcMethod>> = Object.freeze({
  /**
   * Offer a SIGNED transaction to this node's mempool, and relay it on
   * admission — the way in from outside the process.
   *
   * Params: {"transaction": {...}} (aliases tx, signedTransaction) or [{...}].
   * Result: {admitted, id, reason} — the pool's own answer, unedited. A refusal
   * is a RESULT, not a JSON-RPC error: the call succeeded, the transaction did
   * not, and `reason` says which rule it failed ("unauthorised", "replayed",
   * "unaffordable", "duplicate", "pool-full", "sender-full", "malformed").
   * `id` is the transaction id — hex sha256 of its Merkle leaf, the same id
   * chain_mempool lists — and is null when the pool could not compute one.
   *
   * This is NOT a second consensus path. The transaction is judged by the same
   * pool rules a gossiped "tx" frame is, the tip does not move, no ledger is
   * written, and the transaction reaches the chain only if an elected proposer
   * mints it into a block that acceptBlock then judges like any other.
   */
  chain_sendTransaction: (node: RpcNode, params: unknown) => {
    const tx = transactionParam(params)
    const submit = node.submitTransaction
    if (typeof submit !== "function") {
      throw new RpcError(
        RPC_METHOD_NOT_FOUND,
        "this node cannot accept transactions: it has no submitTransaction",
        { reason: "unsupported" }
      )
    }
    const result = submit.call(node, tx) as MempoolResult
    if (!result || typeof result !== "object") {
      throw new RpcError(RPC_INTERNAL_ERROR, "internal error")
    }
    return {
      admitted: result.admitted === true,
      id: result.id === undefined ? null : result.id,
      reason: result.reason,
    }
  },
})

/** The WRITE method names. Loopback-only; see isLoopbackHost. */
export const RPC_WRITE_METHOD_NAMES: string[] = Object.keys(RPC_WRITE_METHODS)

/**
 * What a server actually answers: the reads always, the writes only when this
 * bind serves them. Used for the -32601 `data.methods` hint and by the runner's
 * startup line, so what is advertised is what is served.
 */
export function rpcMethodNames(writesEnabled: boolean): string[] {
  return writesEnabled ? RPC_METHOD_NAMES.concat(RPC_WRITE_METHOD_NAMES) : RPC_METHOD_NAMES.slice()
}

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
function respond(
  node: RpcNode,
  body: string,
  res: ServerResponse,
  writesAllowed: boolean,
  names: string[]
): void {
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

  const isWrite = Object.prototype.hasOwnProperty.call(RPC_WRITE_METHODS, req.method)

  // A write method on a bind that does not serve writes is refused HERE, with
  // its own reason, rather than falling through to "unknown method": an operator
  // who has widened the bind should be told why the call stopped working. (A
  // node with no submitTransaction is refused by the method itself, with
  // data.reason "unsupported" — a different failure and a different answer.)
  if (isWrite && !writesAllowed) {
    sendJson(
      res,
      400,
      errorEnvelope(
        id,
        RPC_METHOD_NOT_FOUND,
        `${req.method} is served on a loopback bind only`,
        { methods: names, reason: "not-loopback" }
      )
    )
    return
  }

  const method = isWrite
    ? RPC_WRITE_METHODS[req.method]
    : Object.prototype.hasOwnProperty.call(RPC_METHODS, req.method)
    ? RPC_METHODS[req.method]
    : undefined
  if (!method) {
    sendJson(
      res,
      400,
      errorEnvelope(id, RPC_METHOD_NOT_FOUND, `unknown method: ${req.method}`, {
        methods: names,
      })
    )
    return
  }

  // A notification asks for no answer. A read has no effect worth running for,
  // so it is acknowledged without being executed; a WRITE is executed — its
  // effect is the whole point of the call — and its answer discarded.
  if (isNotification) {
    if (isWrite) {
      try {
        method(node, req.params)
      } catch (e) {
        // The caller asked for no answer, so there is nowhere to report this.
      }
    }
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

function handleRequest(
  node: RpcNode,
  req: IncomingMessage,
  res: ServerResponse,
  writesAllowed: boolean,
  names: string[]
): void {
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
      respond(node, Buffer.concat(chunks).toString("utf8"), res, writesAllowed, names)
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
 * Start the JSON-RPC server for `node`.
 *
 * Binds loopback unless `host` says otherwise. Pass port 0 to let the operating
 * system pick a free port and read it back from ready(), which is what the tests
 * do so they never collide with the gossip ports.
 *
 * The write method (chain_sendTransaction) is served only when the bind address
 * is a loopback address AND the node has submitTransaction. The decision is made
 * once, here, from the host asked for — not per request from a socket's remote
 * address, which a proxy in front of the server would make meaningless.
 */
export function startRpcServer(
  node: RpcNode,
  port: number = DEFAULT_RPC_PORT,
  host: string = DEFAULT_RPC_HOST
): RpcServerHandle {
  // Two different things: whether this BIND may serve a write at all, and
  // whether this node can actually honour one. The first decides -32601
  // "not-loopback"; the second is the method's own "unsupported" answer. Only
  // when both hold is chain_sendTransaction advertised.
  const writesAllowed = isLoopbackHost(host)
  const writesEnabled = writesAllowed && typeof node.submitTransaction === "function"
  const names = rpcMethodNames(writesEnabled)
  const sockets: Set<Socket> = new Set()
  const server: Server = createServer((req, res) => {
    try {
      handleRequest(node, req, res, writesAllowed, names)
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
    writesEnabled,
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
