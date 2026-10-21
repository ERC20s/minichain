import WebSocket, { Server as WebSocketServer } from "ws"

function hex(u: Uint8Array): string {
  return Array.from(u).map((b) => b.toString(16).padStart(2, "0")).join("")
}
function fromHex(s: string): Uint8Array {
  if (!s) return new Uint8Array(0)
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16)
  return out
}

type MsgEnvelope = {
  type: string
  payloadHex: string
  sigHex?: string
  pubKeyHex?: string
}

/**
 * The frame types this transport carries.
 *
 *  - "tx"  a signed transaction, for the mempool.
 *  - "blk" a block with its header signature and proposer key.
 *  - "req" a request for missing blocks: the payload is
 *          {"from": <height>, "max": <count>} and the answer is ordinary "blk"
 *          frames sent back to the ASKER alone (see the reply() below), never a
 *          broadcast — one node's gap must not cost the whole mesh a re-flood.
 */
export type GossipMessageType = "tx" | "blk" | "req"

/** What a listener is handed for one decoded frame. */
export type GossipMessage = {
  payload: Uint8Array
  sig?: Uint8Array
  pubKey?: Uint8Array
  raw?: MsgEnvelope
  /**
   * Answer THIS sender only, over the socket the frame arrived on.
   *
   * broadcast() sends to every peer, which is right for a new transaction or a
   * new block and wrong for a catch-up answer: a peer that asked for four blocks
   * would otherwise make every other peer receive them again. Undefined when the
   * frame did not arrive over a socket this node can write back to.
   */
  reply?: (
    type: GossipMessageType,
    payload: Uint8Array,
    opts?: { sig?: Uint8Array; pubKey?: Uint8Array }
  ) => void
}

export type GossipNode = {
  broadcast: (type: GossipMessageType, payload: Uint8Array, opts?: { sig?: Uint8Array; pubKey?: Uint8Array }) => void
  on: (type: string, cb: (msg: GossipMessage) => void) => void
  /**
   * Called every time an OUTBOUND peer socket opens — the first dial and every
   * successful re-dial after it. The argument is the peer URL that opened.
   *
   * It exists because a link that has just come up is exactly the moment a node
   * may be behind: it was started before its peer was listening, or the peer
   * restarted while blocks were minted. src/node.ts uses it to send one catch-up
   * "req" at once instead of waiting for a future block to notice the gap.
   */
  onPeerOpen: (cb: (url: string) => void) => void
  /**
   * Return simple peer counts for introspection: inbound server sockets,
   * outbound client sockets that are currently open, and their sum.
   */
  peerCounts: () => { inbound: number; outbound: number; total: number }
  /**
   * Stop listening, stop re-dialling and close every socket. The returned
   * promise settles once the server and every socket have actually closed, so a
   * caller can wait for the ports to be free; it never rejects.
   */
  close: () => Promise<void>
}

/**
 * Outbound re-dial backoff.
 *
 * The transport used to dial each peer exactly once, at startup: a dial that
 * failed was forgotten and a peer that restarted was deleted from the client set
 * for good, so broadcast() wrote into an empty set and the node gossiped into
 * silence. Every peer now keeps being re-dialled, waiting MIN and doubling to
 * MAX between attempts (plus jitter, so a mesh restarted together does not
 * reconnect in lockstep), reset to MIN as soon as the socket opens.
 */
export const PEER_RECONNECT_MIN_MS = 500
export const PEER_RECONNECT_MAX_MS = 15000
/** Up to this fraction of the delay is added at random, so peers spread out. */
export const PEER_RECONNECT_JITTER = 0.25

/**
 * How many INBOUND sockets one node accepts at once. A connection past the cap
 * is closed with 1013 ("try again later") before it can send a frame, so a
 * stranger cannot open sockets until the process runs out of descriptors. The
 * outbound side is already bounded by the PEERS list.
 */
export const MAX_INBOUND_PEERS = 64

/**
 * Per-socket inbound frame budget: a token bucket of MAX_FRAME_BURST frames
 * refilled at MAX_FRAMES_PER_SECOND. A frame that finds the bucket empty is
 * dropped — the socket stays up, so an honest peer that is merely busy loses a
 * frame it can ask for again (a block, through a "req"), while a peer that
 * floods costs this node one subtraction per frame instead of a JSON parse, a
 * hex decode and a signature check. The burst is wider than the largest honest
 * one: a catch-up answer is at most MAX_SYNC_BLOCKS (32) frames back to back.
 */
export const MAX_FRAME_BURST = 256
export const MAX_FRAMES_PER_SECOND = 128

/** Optional transport knobs, so a test can tighten a bound without waiting on it. */
export interface GossipOptions {
  /** Overrides MAX_INBOUND_PEERS. Must be a positive safe integer. */
  maxInboundPeers?: number
  /** Overrides MAX_FRAME_BURST. Must be a positive safe integer. */
  maxFrameBurst?: number
  /** Overrides MAX_FRAMES_PER_SECOND. Must be a positive finite number. */
  maxFramesPerSecond?: number
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
}

/** A token bucket: `tokens` frames may pass now; one more every 1000/rate ms. */
class FrameBudget {
  private tokens: number
  private last: number
  constructor(private readonly burst: number, private readonly perSecond: number) {
    this.tokens = burst
    this.last = Date.now()
  }
  /** Spend one token if there is one. */
  take(): boolean {
    const now = Date.now()
    const elapsed = now - this.last
    if (elapsed > 0) {
      this.tokens = Math.min(this.burst, this.tokens + (elapsed * this.perSecond) / 1000)
      this.last = now
    }
    if (this.tokens < 1) return false
    this.tokens -= 1
    return true
  }
}

// defensive limits
const ALLOWED_TYPES = new Set(["tx", "blk", "req"])
const MAX_PAYLOAD_HEX = 131072 // max chars in hex (64 KiB bytes)
const MAX_SIG_HEX = 1024
const MAX_PUBKEY_HEX = 1024
const HEX_RE = /^[0-9a-fA-F]*$/

// JSON syntax, field names and quotes around the three hex fields. The largest
// envelope this transport ever SENDS is
//   {"type":"blk","payloadHex":"...","sigHex":"...","pubKeyHex":"..."}
// which is 66 characters of framing plus the hex fields, so 200 is a generous
// margin that still leaves the limit tied to the maxima checked below.
const ENVELOPE_OVERHEAD_CHARS = 200
export const MAX_ENVELOPE_CHARS =
  MAX_PAYLOAD_HEX + MAX_SIG_HEX + MAX_PUBKEY_HEX + ENVELOPE_OVERHEAD_CHARS

// A UTF-8 sequence never uses more than 3 bytes per UTF-16 code unit (a 3-byte
// BMP character is one unit; a 4-byte character is two units), so a frame over
// this many BYTES cannot decode to a string within MAX_ENVELOPE_CHARS. Checking
// it first lets us drop a huge binary frame without even building the string.
//
// It is also handed to ws as `maxPayload`, on the server and on every outbound
// socket. Without that the library's default (100 MiB) applied, so a peer could
// make this node BUFFER a hundred megabytes per frame before the length check
// here ever ran. Past maxPayload, ws aborts the read and closes that socket
// with 1009 ("message too big"); an honest peer never sends such a frame, since
// its own encoder is bounded by the same maxima.
export const MAX_ENVELOPE_BYTES = MAX_ENVELOPE_CHARS * 3

function validHexString(s: any, maxLen: number): s is string {
  if (typeof s !== "string") return false
  if (s.length % 2 !== 0) return false
  if (s.length > maxLen) return false
  if (!HEX_RE.test(s)) return false
  return true
}

// Size of an incoming ws frame in bytes, without converting it to a string.
// Returns undefined when the size cannot be determined cheaply (e.g. the frame
// was already delivered as a string), in which case the caller falls back to
// the character check.
function incomingByteLength(data: any): number | undefined {
  if (data === null || data === undefined) return undefined
  if (typeof data === "string") return undefined
  if (Array.isArray(data)) {
    let total = 0
    for (const part of data) {
      const n = incomingByteLength(part)
      if (n === undefined) return undefined
      total += n
    }
    return total
  }
  if (typeof data.byteLength === "number") return data.byteLength
  if (typeof data.length === "number") return data.length
  return undefined
}

export function startGossipNode(port: number, peers: string[], options?: GossipOptions): GossipNode {
  const maxInboundPeers = positiveInteger(options && options.maxInboundPeers, MAX_INBOUND_PEERS)
  const maxFrameBurst = positiveInteger(options && options.maxFrameBurst, MAX_FRAME_BURST)
  const maxFramesPerSecond = positiveNumber(options && options.maxFramesPerSecond, MAX_FRAMES_PER_SECOND)

  const server = new WebSocketServer({ port, maxPayload: MAX_ENVELOPE_BYTES })
  const sockets: Set<WebSocket> = new Set()
  const listeners: Map<string, ((msg: any) => void)[]> = new Map()
  /** One frame budget per live socket, inbound or outbound. */
  const budgets: WeakMap<WebSocket, FrameBudget> = new WeakMap()

  function emit(type: string, obj: any) {
    const cbs = listeners.get(type) || []
    for (const cb of cbs) cb(obj)
  }

  // One place that builds the wire form, so a broadcast and a per-socket reply
  // are byte-identical envelopes.
  function encodeEnvelope(
    type: GossipMessageType,
    payload: Uint8Array,
    opts?: { sig?: Uint8Array; pubKey?: Uint8Array }
  ): string {
    const env: MsgEnvelope = { type, payloadHex: hex(payload) }
    if (opts?.sig) env.sigHex = hex(opts.sig)
    if (opts?.pubKey) env.pubKeyHex = hex(opts.pubKey)
    return JSON.stringify(env)
  }

  function replyOver(ws: WebSocket) {
    return (
      type: GossipMessageType,
      payload: Uint8Array,
      opts?: { sig?: Uint8Array; pubKey?: Uint8Array }
    ) => {
      try {
        ws.send(encodeEnvelope(type, payload, opts))
      } catch (e) {
        // a socket that went away mid-answer costs the asker its answer, nothing more
      }
    }
  }

  // `from` is the socket the frame arrived on, so a listener can answer that
  // peer alone. It is optional so the guards below keep working unchanged.
  function handleIncomingMessage(data: WebSocket.Data, from?: WebSocket) {
    try {
      // Rate first: a peer over its frame budget costs one subtraction.
      if (from) {
        let budget = budgets.get(from)
        if (!budget) {
          budget = new FrameBudget(maxFrameBurst, maxFramesPerSecond)
          budgets.set(from, budget)
        }
        if (!budget.take()) return
      }
      // Size next: a peer that sends megabytes of JSON should cost us a
      // length comparison, not a parse and the allocations behind it.
      const bytes = incomingByteLength(data)
      if (bytes !== undefined && bytes > MAX_ENVELOPE_BYTES) return
      const s = typeof data === "string" ? data : data.toString()
      if (s.length > MAX_ENVELOPE_CHARS) return
      const env = JSON.parse(s) as MsgEnvelope
      // validate envelope before decoding hex
      if (!ALLOWED_TYPES.has(env.type)) return
      if (!validHexString(env.payloadHex, MAX_PAYLOAD_HEX)) return
      if (env.sigHex !== undefined && !validHexString(env.sigHex, MAX_SIG_HEX)) return
      if (env.pubKeyHex !== undefined && !validHexString(env.pubKeyHex, MAX_PUBKEY_HEX)) return
      const payload = fromHex(env.payloadHex)
      const sig = env.sigHex ? fromHex(env.sigHex) : undefined
      const pubKey = env.pubKeyHex ? fromHex(env.pubKeyHex) : undefined
      emit(env.type, {
        payload,
        sig,
        pubKey,
        raw: env,
        reply: from ? replyOver(from) : undefined,
      })
    } catch (e) {
      // ignore parse errors and invalid envelopes
    }
  }

  server.on("connection", (ws: WebSocket) => {
    if (sockets.size >= maxInboundPeers) {
      // Over the cap: refused before a single frame is read. 1013 is the
      // standard "try again later", which an honest peer's re-dial will.
      ws.on("error", () => {})
      try { ws.close(1013, "too many peers") } catch (e) {}
      return
    }
    sockets.add(ws)
    ws.on("message", (data: WebSocket.Data) => {
      handleIncomingMessage(data, ws)
    })
    ws.on("close", () => sockets.delete(ws))
    ws.on("error", () => sockets.delete(ws))
  })

  // connect to peers
  //
  // One connectPeer() per configured URL, and it never gives up: a socket that
  // closes or errors schedules the next dial after a backoff, and a socket that
  // opens resets that backoff to the minimum. This is what makes the two most
  // ordinary things in a small mesh survivable — starting node A with PEERS
  // pointing at a node B that is not listening yet, and restarting any node.
  const clients: Set<WebSocket> = new Set()
  // Every outbound socket, open or still connecting, so close() can shut a
  // half-dialled one too. `clients` holds only the OPEN sockets broadcast writes to.
  const peerSockets: Set<WebSocket> = new Set()
  const peerOpenListeners: ((url: string) => void)[] = []
  const reconnectTimers: Set<ReturnType<typeof setTimeout>> = new Set()
  let closed = false

  function backoffDelay(attempt: number): number {
    const n = attempt < 1 ? 1 : attempt
    // 500, 1000, 2000 ... capped at 15000. Math.pow is bounded by the cap, so a
    // long-dead peer cannot overflow the exponent into Infinity.
    const capped = Math.min(
      PEER_RECONNECT_MAX_MS,
      PEER_RECONNECT_MIN_MS * Math.pow(2, Math.min(n - 1, 32))
    )
    return Math.round(capped + Math.random() * capped * PEER_RECONNECT_JITTER)
  }

  function connectPeer(url: string, attempt: number = 0): void {
    if (closed) return

    // "error" is followed by "close" on almost every failed dial, so without
    // this flag one failure would schedule two re-dials and the peer's dial rate
    // would double at every round. One scheduled re-dial per connectPeer call.
    let scheduled = false
    const scheduleRetry = () => {
      if (scheduled || closed) return
      scheduled = true
      const timer = setTimeout(() => {
        reconnectTimers.delete(timer)
        connectPeer(url, attempt + 1)
      }, backoffDelay(attempt + 1))
      // Never hold a process — or a jest run — open just to wait for a re-dial.
      if (typeof (timer as any).unref === "function") (timer as any).unref()
      reconnectTimers.add(timer)
    }

    let dialled: WebSocket | undefined
    try {
      dialled = new WebSocket(url, { maxPayload: MAX_ENVELOPE_BYTES })
    } catch (e) {
      // A URL the ws constructor throws on (a bad scheme, say) is retried like
      // any other failure rather than dropped for the lifetime of the node.
      dialled = undefined
    }
    if (!dialled) {
      scheduleRetry()
      return
    }
    const c = dialled
    peerSockets.add(c)

    c.on("open", () => {
      if (closed) {
        try { c.close() } catch (e) {}
        return
      }
      // The link is up: the next failure starts again from the minimum delay.
      attempt = 0
      clients.add(c)
      for (const cb of peerOpenListeners) {
        try {
          cb(url)
        } catch (e) {
          // a listener that throws must not take the transport down
        }
      }
    })
    c.on("message", (data: WebSocket.Data) => {
      handleIncomingMessage(data, c)
    })
    c.on("close", () => {
      clients.delete(c)
      peerSockets.delete(c)
      scheduleRetry()
    })
    c.on("error", () => {
      clients.delete(c)
      peerSockets.delete(c)
      scheduleRetry()
    })
  }

  for (const p of Array.isArray(peers) ? peers : []) connectPeer(p)

  function broadcast(type: GossipMessageType, payload: Uint8Array, opts?: { sig?: Uint8Array; pubKey?: Uint8Array }) {
    const s = encodeEnvelope(type, payload, opts)
    // send to server-connected sockets
    for (const ws of sockets) {
      try {
        ws.send(s)
      } catch (e) {}
    }
    // send to outgoing client sockets
    for (const c of clients) {
      try {
        c.send(s)
      } catch (e) {}
    }
  }

  function on(type: string, cb: (msg: GossipMessage) => void) {
    const arr = listeners.get(type) || []
    arr.push(cb)
    listeners.set(type, arr)
  }

  function onPeerOpen(cb: (url: string) => void) {
    if (typeof cb === "function") peerOpenListeners.push(cb)
  }

  // Settles when `ws` has closed: at once if it already has, else on its own
  // "close" event, which follows close() on an open or a still-dialling socket.
  function closeSocket(ws: WebSocket): Promise<void> {
    if (ws.readyState === WebSocket.CLOSED) return Promise.resolve()
    return new Promise<void>((resolve) => {
      ws.once("close", () => resolve())
      try { ws.close() } catch (e) { resolve() }
    })
  }

  function close(): Promise<void> {
    // Set FIRST: every close below fires a "close" event, and without the flag
    // each one would schedule the re-dial this call is meant to stop.
    closed = true
    for (const t of reconnectTimers) {
      try { clearTimeout(t) } catch (e) {}
    }
    reconnectTimers.clear()
    const done: Promise<void>[] = [
      new Promise<void>((resolve) => {
        try {
          server.close(() => resolve())
        } catch (e) {
          resolve()
        }
      }),
    ]
    for (const ws of new Set([...peerSockets, ...clients, ...sockets])) done.push(closeSocket(ws))
    clients.clear()
    peerSockets.clear()
    return Promise.all(done).then(() => undefined)
  }

  function peerCounts() {
    const inbound = sockets.size
    const outbound = clients.size
    return { inbound, outbound, total: inbound + outbound }
  }

  return { broadcast, on, onPeerOpen, peerCounts, close }
}
