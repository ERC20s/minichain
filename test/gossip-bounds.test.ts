import WebSocket, { Server as WebSocketServer } from "ws"
import {
  MAX_ENVELOPE_BYTES,
  MAX_FRAMES_PER_SECOND,
  MAX_FRAME_BURST,
  MAX_INBOUND_PEERS,
  startGossipNode,
} from "../src/gossip/ws"
import { MAX_SYNC_BLOCKS, Node } from "../src/node"
import { createGenesisBlock } from "../src/block"
import { closeAll, waitForPeers, waitUntil } from "./helpers/gossip"

/**
 * Bounds on gossip input (src/gossip/ws.ts): the inbound peer count, the
 * per-socket frame rate, and the frame size enforced by ws itself on both
 * server and outbound sockets. Ports 9781-9786 are used by no other test file.
 */
function wait(ms: number) {
  return new Promise((res) => setTimeout(res, ms))
}

function hex(u: Uint8Array): string {
  return Buffer.from(u).toString("hex")
}

function txEnvelope(n: number): string {
  return JSON.stringify({ type: "tx", payloadHex: hex(new TextEncoder().encode(String(n))) })
}

function closable(ws: WebSocket) {
  return {
    close: () =>
      new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve()
        ws.once("close", () => resolve())
        try { ws.close() } catch (e) { resolve() }
      }),
  }
}

function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.on("error", () => {})
    ws.once("open", () => resolve(ws))
    ws.once("close", () => reject(new Error("closed before open")))
  })
}

describe("gossip input bounds", () => {
  it("defaults are wide enough for honest traffic and narrower than nothing", () => {
    expect(MAX_INBOUND_PEERS).toBeGreaterThan(0)
    expect(MAX_FRAME_BURST).toBeGreaterThanOrEqual(MAX_SYNC_BLOCKS)
    expect(MAX_FRAMES_PER_SECOND).toBeGreaterThan(0)
    expect(MAX_ENVELOPE_BYTES).toBeLessThan(1024 * 1024)
  })

  it("closes an inbound connection past the cap with 1013 and keeps serving the rest", async () => {
    const node = startGossipNode(9781, [], { maxInboundPeers: 2 })
    const delivered: string[] = []
    node.on("tx", (m) => delivered.push(new TextDecoder().decode(m.payload)))
    const socks: WebSocket[] = []
    try {
      socks.push(await open("ws://127.0.0.1:9781"))
      socks.push(await open("ws://127.0.0.1:9781"))
      await waitForPeers(node, { inbound: 2 }, undefined, "node")

      const third = new WebSocket("ws://127.0.0.1:9781")
      third.on("error", () => {})
      socks.push(third)
      const code = await new Promise<number>((res) => third.on("close", (c) => res(c)))
      expect(code).toBe(1013)
      expect(node.peerCounts().inbound).toBe(2)

      // the two admitted sockets still work
      socks[0].send(txEnvelope(1))
      socks[1].send(txEnvelope(2))
      await waitUntil(() => delivered.length >= 2, "the admitted sockets to be served")
      expect(delivered.sort()).toEqual(["1", "2"])

      // a slot freed by a departure is handed to the next arrival
      await closable(socks[0]).close()
      await waitUntil(() => node.peerCounts().inbound === 1, "the departure to be counted")
      const fourth = await open("ws://127.0.0.1:9781")
      socks.push(fourth)
      fourth.send(txEnvelope(4))
      await waitUntil(() => delivered.length >= 3, "the fourth socket to be served")
      expect(delivered).toContain("4")
    } finally {
      await closeAll(...socks.map(closable), node)
    }
  }, 10000)

  it("drops frames past a socket's burst budget and lets one through once it has refilled", async () => {
    const node = startGossipNode(9782, [], { maxFrameBurst: 5, maxFramesPerSecond: 1 })
    const delivered: string[] = []
    node.on("tx", (m) => delivered.push(new TextDecoder().decode(m.payload)))
    let sock: WebSocket | undefined
    try {
      sock = await open("ws://127.0.0.1:9782")
      for (let n = 1; n <= 12; n++) sock.send(txEnvelope(n))
      await waitUntil(() => delivered.length >= 5, "the burst to be delivered")
      await wait(300)
      // exactly the burst, in order; the rest were dropped, not queued
      expect(delivered).toEqual(["1", "2", "3", "4", "5"])
      expect(sock.readyState).toBe(WebSocket.OPEN)

      // one token per second: after 1.5s exactly one more frame passes
      await wait(1500)
      sock.send(txEnvelope(13))
      await waitUntil(() => delivered.length >= 6, "a frame after the refill to be delivered")
      expect(delivered[5]).toBe("13")
    } finally {
      await closeAll(sock && closable(sock), node)
    }
  }, 10000)

  it("an outbound peer that sends an oversized frame is cut off at maxPayload, and the node lives on", async () => {
    // a rogue "peer": a bare server that greets every client with 1 MiB
    const rogue = new WebSocketServer({ port: 9783 })
    const closes: number[] = []
    let connections = 0
    rogue.on("connection", (ws) => {
      connections++
      ws.on("error", () => {})
      ws.on("close", (code) => closes.push(code))
      ws.send(JSON.stringify({ type: "tx", payloadHex: "a".repeat(1024 * 1024) }))
    })
    const node = startGossipNode(9784, ["ws://127.0.0.1:9783"])
    let delivered = 0
    node.on("tx", () => delivered++)
    try {
      await waitUntil(() => closes.length >= 1, "the node to cut the oversized frame off", 8000)
      // the rogue saw its client go away with "message too big"...
      expect(closes[0]).toBe(1009)
      expect(delivered).toBe(0)
      // ...and the node is still running: it re-dials the peer as usual
      await waitUntil(() => connections >= 2, "the node to re-dial the peer", 8000)
      expect(node.peerCounts()).toBeDefined()
    } finally {
      await closeAll(node, {
        close: () => new Promise<void>((resolve) => rogue.close(() => resolve())),
      })
    }
  }, 15000)

  it("a Node passes its gossip options through to the transport", async () => {
    const node = new Node(9785, [], createGenesisBlock(), [], undefined, { gossip: { maxInboundPeers: 1 } })
    const socks: WebSocket[] = []
    try {
      socks.push(await open("ws://127.0.0.1:9785"))
      await waitForPeers(node, { inbound: 1 }, undefined, "node")
      const second = new WebSocket("ws://127.0.0.1:9785")
      second.on("error", () => {})
      socks.push(second)
      const code = await new Promise<number>((res) => second.on("close", (c) => res(c)))
      expect(code).toBe(1013)
      expect(node.peerCounts().inbound).toBe(1)
    } finally {
      await closeAll(...socks.map(closable), node)
    }
  }, 10000)
})
