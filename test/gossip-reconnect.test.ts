import { Server as WebSocketServer } from "ws"
import { createGenesisBlock } from "../src/block"
import { Node } from "../src/node"
import {
  PEER_RECONNECT_MAX_MS,
  PEER_RECONNECT_MIN_MS,
  startGossipNode,
} from "../src/gossip/ws"

/**
 * Outbound peers are re-dialled (src/gossip/ws.ts) and a reconnected link asks
 * for the gap (src/node.ts).
 *
 * Before this, the transport dialled each peer exactly ONCE, at startup:
 *
 *   for (const p of peers) { const c = new WebSocket(p); c.on("open", ...);
 *     c.on("close", () => clients.delete(c)); c.on("error", () => clients.delete(c)) }
 *
 * A dial that failed was forgotten and a peer that restarted was deleted from
 * `clients` for good, so broadcast() wrote into an empty set and the node
 * gossiped into silence — for ever. Two entirely ordinary things did it:
 * starting a node before the peer named in PEERS was listening, and restarting
 * any node. What is pinned here:
 *
 *  - a peer dialled BEFORE it listens is reached once it comes up;
 *  - a peer restarted on the same port receives again;
 *  - close() stops the re-dialling for good, and leaves no live timer;
 *  - onPeerOpen fires on the first open and on every re-open;
 *  - a Node sends one catch-up "req" when a peer link comes up, so it does not
 *    have to wait for a future block to notice it is behind.
 *
 * Timing: the first re-dial waits PEER_RECONNECT_MIN_MS (500 ms) plus jitter,
 * so every wait below is generous rather than tight, and the delivery checks
 * re-broadcast while they poll instead of assuming one exact moment.
 *
 * The gossip ports used below (9661-9670) are used by no other test file.
 */
function wait(ms: number) {
  return new Promise((res) => setTimeout(res, ms))
}

/** Poll until `cond` holds, re-running `poke` each round; returns whether it did. */
async function until(
  cond: () => boolean,
  timeoutMs: number,
  poke?: () => void
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return true
    if (poke) {
      try {
        poke()
      } catch (e) {}
    }
    await wait(100)
  }
  return cond()
}

const MSG = new TextEncoder().encode("hello")

describe("gossip peers reconnect", () => {
  it("keeps the backoff bounded and rising from the minimum", () => {
    expect(PEER_RECONNECT_MIN_MS).toBeGreaterThan(0)
    expect(PEER_RECONNECT_MAX_MS).toBeGreaterThanOrEqual(PEER_RECONNECT_MIN_MS)
  })

  it("reaches a peer that was not listening when it was first dialled", async () => {
    const urlB = "ws://127.0.0.1:9662"
    // A is started with PEERS pointing at a node that does not exist yet. The
    // old transport dropped this dial and never tried again.
    const a = startGossipNode(9661, [urlB])
    let b: ReturnType<typeof startGossipNode> | undefined
    try {
      await wait(150)
      b = startGossipNode(9662, [])
      let got = 0
      b.on("tx", () => {
        got++
      })

      const delivered = await until(() => got > 0, 5000, () => a.broadcast("tx", MSG))
      expect(delivered).toBe(true)
    } finally {
      if (b) b.close()
      a.close()
      await wait(20)
    }
  }, 20000)

  it("reaches a peer again after it restarts on the same port", async () => {
    const urlB = "ws://127.0.0.1:9664"
    const a = startGossipNode(9663, [urlB])
    let b1: ReturnType<typeof startGossipNode> | undefined
    let b2: ReturnType<typeof startGossipNode> | undefined
    try {
      b1 = startGossipNode(9664, [])
      let first = 0
      b1.on("tx", () => {
        first++
      })
      expect(await until(() => first > 0, 3000, () => a.broadcast("tx", MSG))).toBe(true)

      // B goes away — the socket A holds is closed under it.
      b1.close()
      b1 = undefined
      await wait(400) // let the listening socket actually go away before rebinding

      // ...and comes back on the same port, as a restarted node does.
      b2 = startGossipNode(9664, [])
      let second = 0
      b2.on("tx", () => {
        second++
      })
      expect(await until(() => second > 0, 8000, () => a.broadcast("tx", MSG))).toBe(true)
    } finally {
      if (b1) b1.close()
      if (b2) b2.close()
      a.close()
      await wait(20)
    }
  }, 30000)

  it("fires onPeerOpen on the first open and on every re-open", async () => {
    const opens: string[] = []
    const a = startGossipNode(9665, ["ws://127.0.0.1:9666"])
    a.onPeerOpen((url) => opens.push(url))
    let b1: ReturnType<typeof startGossipNode> | undefined
    let b2: ReturnType<typeof startGossipNode> | undefined
    try {
      b1 = startGossipNode(9666, [])
      expect(await until(() => opens.length >= 1, 3000)).toBe(true)
      expect(opens[0]).toBe("ws://127.0.0.1:9666")

      b1.close()
      b1 = undefined
      await wait(400)
      b2 = startGossipNode(9666, [])
      expect(await until(() => opens.length >= 2, 8000)).toBe(true)
    } finally {
      if (b1) b1.close()
      if (b2) b2.close()
      a.close()
      await wait(20)
    }
  }, 30000)

  it("stops re-dialling once close() is called", async () => {
    // Nothing is listening on 9668, so A is in the re-dial loop from the start.
    const a = startGossipNode(9667, ["ws://127.0.0.1:9668"])
    let late: WebSocketServer | undefined
    try {
      await wait(900) // at least one re-dial has been scheduled and fired
      a.close()
      await wait(100)

      // A server started AFTER close() must never see a connection: if the
      // backoff timers were still running, one would land here.
      let connections = 0
      late = new WebSocketServer({ port: 9668 })
      late.on("connection", (ws) => {
        connections++
        try {
          ws.close()
        } catch (e) {}
      })
      await wait(2500)
      expect(connections).toBe(0)
    } finally {
      if (late) {
        await new Promise((res) => late!.close(() => res(null)))
      }
      await wait(20)
    }
  }, 20000)

  it("makes a Node ask for the gap when a peer link comes up", async () => {
    const genesis = createGenesisBlock()
    // The peer B talks to. No validators and no opening balances: this test is
    // about WHEN a request goes out, not about what comes back.
    let a: Node | undefined = new Node(9669, [], genesis, [])
    let b: Node | undefined
    try {
      await wait(100)

      b = new Node(9670, ["ws://127.0.0.1:9669"], genesis, [], undefined, {
        syncRequestIntervalMs: 0, // no rate limit in this test
      })
      // Wrapped synchronously, before any socket can have opened.
      const sent: string[] = []
      const real = b.gossip.broadcast
      b.gossip.broadcast = (type, payload, opts) => {
        sent.push(type)
        real(type, payload, opts)
      }

      // First open: the node asks at once instead of waiting for a block it
      // cannot use to tell it that it is behind.
      expect(await until(() => sent.filter((t) => t === "req").length >= 1, 3000)).toBe(true)

      // The peer restarts; the link is re-dialled and the node asks again.
      a.close()
      a = undefined
      await wait(400) // let the listening socket go away before rebinding the port
      a = new Node(9669, [], genesis, [])
      expect(await until(() => sent.filter((t) => t === "req").length >= 2, 8000)).toBe(true)
    } finally {
      if (b) b.close()
      if (a) a.close()
      await wait(20)
    }
  }, 30000)
})
