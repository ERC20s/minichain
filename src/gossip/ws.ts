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

export type GossipNode = {
  broadcast: (type: "tx" | "blk", payload: Uint8Array, opts?: { sig?: Uint8Array; pubKey?: Uint8Array }) => void
  on: (type: string, cb: (msg: { payload: Uint8Array; sig?: Uint8Array; pubKey?: Uint8Array; raw?: MsgEnvelope }) => void) => void
  close: () => void
}

// defensive limits
const ALLOWED_TYPES = new Set(["tx", "blk"])
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
const MAX_ENVELOPE_BYTES = MAX_ENVELOPE_CHARS * 3

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

export function startGossipNode(port: number, peers: string[]): GossipNode {
  const server = new WebSocketServer({ port })
  const sockets: Set<WebSocket> = new Set()
  const listeners: Map<string, ((msg: any) => void)[]> = new Map()

  function emit(type: string, obj: any) {
    const cbs = listeners.get(type) || []
    for (const cb of cbs) cb(obj)
  }

  function handleIncomingMessage(data: WebSocket.Data) {
    try {
      // Size first: a peer that sends megabytes of JSON should cost us a
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
      emit(env.type, { payload, sig, pubKey, raw: env })
    } catch (e) {
      // ignore parse errors and invalid envelopes
    }
  }

  server.on("connection", (ws: WebSocket) => {
    sockets.add(ws)
    ws.on("message", (data: WebSocket.Data) => {
      handleIncomingMessage(data)
    })
    ws.on("close", () => sockets.delete(ws))
    ws.on("error", () => sockets.delete(ws))
  })

  // connect to peers
  const clients: Set<WebSocket> = new Set()
  for (const p of peers) {
    try {
      const c = new WebSocket(p)
      c.on("open", () => {
        clients.add(c)
      })
      c.on("message", (data: WebSocket.Data) => {
        handleIncomingMessage(data)
      })
      c.on("close", () => clients.delete(c))
      c.on("error", () => clients.delete(c))
    } catch (e) {
      // ignore
    }
  }

  function broadcast(type: "tx" | "blk", payload: Uint8Array, opts?: { sig?: Uint8Array; pubKey?: Uint8Array }) {
    const env: MsgEnvelope = { type, payloadHex: hex(payload) }
    if (opts?.sig) env.sigHex = hex(opts.sig)
    if (opts?.pubKey) env.pubKeyHex = hex(opts.pubKey)
    const s = JSON.stringify(env)
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

  function on(type: string, cb: (msg: { payload: Uint8Array; sig?: Uint8Array; pubKey?: Uint8Array; raw?: MsgEnvelope }) => void) {
    const arr = listeners.get(type) || []
    arr.push(cb)
    listeners.set(type, arr)
  }

  function close() {
    try {
      server.close()
    } catch (e) {}
    for (const c of clients) try { c.close() } catch (e) {}
    for (const s of sockets) try { s.close() } catch (e) {}
  }

  return { broadcast, on, close }
}
