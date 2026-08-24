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

export function startGossipNode(port: number, peers: string[]): GossipNode {
  const server = new WebSocketServer({ port })
  const sockets: Set<WebSocket> = new Set()
  const listeners: Map<string, ((msg: any) => void)[]> = new Map()

  function emit(type: string, obj: any) {
    const cbs = listeners.get(type) || []
    for (const cb of cbs) cb(obj)
  }

  server.on("connection", (ws: WebSocket) => {
    sockets.add(ws)
    ws.on("message", (data: WebSocket.Data) => {
      try {
        const s = typeof data === "string" ? data : data.toString()
        const env = JSON.parse(s) as MsgEnvelope
        const payload = fromHex(env.payloadHex)
        const sig = env.sigHex ? fromHex(env.sigHex) : undefined
        const pubKey = env.pubKeyHex ? fromHex(env.pubKeyHex) : undefined
        emit(env.type, { payload, sig, pubKey, raw: env })
      } catch (e) {
        // ignore
      }
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
        try {
          const s = typeof data === "string" ? data : data.toString()
          const env = JSON.parse(s) as MsgEnvelope
          const payload = fromHex(env.payloadHex)
          const sig = env.sigHex ? fromHex(env.sigHex) : undefined
          const pubKey = env.pubKeyHex ? fromHex(env.pubKeyHex) : undefined
          emit(env.type, { payload, sig, pubKey, raw: env })
        } catch (e) {
          // ignore
        }
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
