import WebSocket from "ws"
import { startGossipNode, MAX_ENVELOPE_BYTES, MAX_ENVELOPE_CHARS } from "../src/gossip/ws"
import { keypairFromSeed, sign, verify } from "../src/crypto/ed25519"
import { canonicalEncoding } from "../src/coding/serialize"
import { closeAll, waitForPeers, waitUntil } from "./helpers/gossip"

function wait(ms: number) { return new Promise((res) => setTimeout(res, ms)) }

/** A raw client socket as a Closable: close() resolves once it has closed. */
function closableSocket(ws: WebSocket) {
  return {
    close: () =>
      new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve()
        ws.once("close", () => resolve())
        ws.close()
      }),
  }
}

describe("gossip websocket transport", () => {
  it("delivers a signed transaction from node A to node B", async () => {
    const portA = 9101
    const portB = 9102
    const urlA = `ws://127.0.0.1:${portA}`
    const urlB = `ws://127.0.0.1:${portB}`

    const nodeA = startGossipNode(portA, [urlB])
    const nodeB = startGossipNode(portB, [urlA])

    const seed = new Uint8Array(32)
    seed[0] = 1
    const kp = keypairFromSeed(seed)

    const tx = { sender: "alice", recipient: "bob", amount: 7, nonce: 1 }
    const msg = canonicalEncoding(tx as any)
    const sig = sign(msg, kp.secretKey)

    let received = false
    nodeB.on("tx", (m) => {
      try {
        expect(m.payload).toEqual(msg)
        expect(m.sig).toBeDefined()
        expect(verify(m.payload, m.sig!, kp.publicKey)).toBe(true)
        received = true
      } catch (e) {
        // swallow assertion to let test continue and fail
      }
    })

    try {
      await waitForPeers(nodeA, { inbound: 1, outbound: 1 }, undefined, "nodeA")
      await waitForPeers(nodeB, { inbound: 1, outbound: 1 }, undefined, "nodeB")
      nodeA.broadcast("tx", msg, { sig, pubKey: kp.publicKey })

      await waitUntil(() => received, "nodeB to receive the signed tx")
      expect(received).toBe(true)
    } finally {
      await closeAll(nodeA, nodeB)
    }
  }, 15000)

  it("delivers a block message between peers", async () => {
    const portA = 9201
    const portB = 9202
    const urlA = `ws://127.0.0.1:${portA}`
    const urlB = `ws://127.0.0.1:${portB}`

    const nodeA = startGossipNode(portA, [urlB])
    const nodeB = startGossipNode(portB, [urlA])

    const blk = { parentHash: "0x00", height: 1, timestamp: Date.now(), transactions: [], merkleRoot: "0x00" }
    const payload = new TextEncoder().encode(JSON.stringify(blk))

    let got = false
    nodeB.on("blk", (m) => {
      try {
        expect(new TextDecoder().decode(m.payload)).toEqual(JSON.stringify(blk))
        got = true
      } catch (e) {}
    })

    try {
      await waitForPeers(nodeA, { inbound: 1, outbound: 1 }, undefined, "nodeA")
      await waitForPeers(nodeB, { inbound: 1, outbound: 1 }, undefined, "nodeB")
      nodeA.broadcast("blk", payload)

      await waitUntil(() => got, "nodeB to receive the block message")
      expect(got).toBe(true)
    } finally {
      await closeAll(nodeA, nodeB)
    }
  }, 15000)

  it("ignores an oversized payloadHex without crashing", async () => {
    const portA = 9721
    const portB = 9722
    const urlA = `ws://127.0.0.1:${portA}`
    const urlB = `ws://127.0.0.1:${portB}`

    const nodeA = startGossipNode(portA, [urlB])
    const nodeB = startGossipNode(portB, [urlA])

    let received = false
    nodeB.on("tx", (m) => {
      received = true
    })

    let ws: WebSocket | undefined
    try {
      await waitForPeers(nodeA, { inbound: 1, outbound: 1 }, undefined, "nodeA")
      await waitForPeers(nodeB, { inbound: 1, outbound: 1 }, undefined, "nodeB")

      // craft an oversized payloadHex (one more than MAX_PAYLOAD_HEX)
      const oversized = "f".repeat(131073)
      const env = JSON.stringify({ type: "tx", payloadHex: oversized })

      // send directly to server socket set (connect and send)
      const sock = new WebSocket(urlA)
      ws = sock
      await new Promise((res) => sock.on("open", res))
      sock.send(env)

      // a window in which nothing must arrive
      await wait(200)

      expect(received).toBe(false)
    } finally {
      await closeAll(ws && closableSocket(ws), nodeA, nodeB)
    }
  }, 15000)

  it("refuses a frame too large to be an envelope at the socket, and keeps serving", async () => {
    // This test used to expect the SAME socket to carry a normal frame after a
    // 1 MiB one: the transport buffered the whole frame (ws's default
    // maxPayload is 100 MiB) and then dropped it by length. The real bound is
    // now ws's maxPayload = MAX_ENVELOPE_BYTES, so an oversized frame is cut
    // off mid-read and the offending socket is closed with 1009 ("message too
    // big") — nothing is buffered, nothing is parsed, nothing is delivered —
    // and the node goes on serving every other socket, including a fresh one
    // from the same peer.
    const portA = 9723
    const portB = 9724
    const urlA = `ws://127.0.0.1:${portA}`
    const urlB = `ws://127.0.0.1:${portB}`

    const nodeA = startGossipNode(portA, [urlB])
    const nodeB = startGossipNode(portB, [urlA])

    const delivered: string[] = []
    nodeA.on("tx", (m) => {
      delivered.push(new TextDecoder().decode(m.payload))
    })

    let first: WebSocket | undefined
    let second: WebSocket | undefined
    try {
      await waitForPeers(nodeA, { inbound: 1, outbound: 1 }, undefined, "nodeA")
      await waitForPeers(nodeB, { inbound: 1, outbound: 1 }, undefined, "nodeB")

      const sock = new WebSocket(urlA)
      first = sock
      const closedWith = new Promise<number>((res) => sock.on("close", (code) => res(code)))
      await new Promise((res) => sock.on("open", res))

      // 1 MiB of JSON: far past any envelope this transport can accept.
      const huge = JSON.stringify({ type: "tx", payloadHex: "a".repeat(1024 * 1024) })
      expect(huge.length).toBeGreaterThan(MAX_ENVELOPE_CHARS)
      expect(huge.length).toBeGreaterThan(MAX_ENVELOPE_BYTES)
      const started = Date.now()
      sock.send(huge)

      // the socket that sent it is closed by the server: 1009, message too big
      expect(await closedWith).toBe(1009)
      expect(delivered.length).toBe(0)

      // a fresh connection from the same peer is served as normal
      const again = new WebSocket(urlA)
      second = again
      await new Promise((res) => again.on("open", res))
      const good = JSON.stringify({ type: "tx", payloadHex: "abcd" })
      again.send(good)
      await waitUntil(() => delivered.length >= 1, "nodeA to deliver the normal frame")

      expect(delivered.length).toBe(1)
      expect(Date.now() - started).toBeLessThan(2000)
    } finally {
      await closeAll(first && closableSocket(first), second && closableSocket(second), nodeA, nodeB)
    }
  }, 15000)

  it("still delivers an envelope that sits just under the size limit", async () => {
    const portA = 9501
    const portB = 9502
    const urlA = `ws://127.0.0.1:${portA}`
    const urlB = `ws://127.0.0.1:${portB}`

    const nodeA = startGossipNode(portA, [urlB])
    const nodeB = startGossipNode(portB, [urlA])

    // 64 KiB payload (131072 hex chars = MAX_PAYLOAD_HEX) plus a 64-byte
    // signature and a 32-byte public key: the biggest legal envelope.
    const payload = new Uint8Array(65536)
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251

    let got: Uint8Array | undefined
    nodeB.on("tx", (m) => {
      got = m.payload
    })

    try {
      await waitForPeers(nodeA, { inbound: 1, outbound: 1 }, undefined, "nodeA")
      await waitForPeers(nodeB, { inbound: 1, outbound: 1 }, undefined, "nodeB")
      nodeA.broadcast("tx", payload, { sig: new Uint8Array(64), pubKey: new Uint8Array(32) })

      await waitUntil(() => got !== undefined, "nodeB to receive the largest legal envelope")
      expect(got).toBeDefined()
      expect(got!.length).toBe(payload.length)
      expect(got!).toEqual(payload)
    } finally {
      await closeAll(nodeA, nodeB)
    }
  }, 15000)
})
