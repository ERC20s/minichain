import WebSocket, { Server as WebSocketServer } from "ws"
import { PEER_RECONNECT_MIN_MS, startGossipNode } from "../src/gossip/ws"
import { closeAll, waitUntil } from "./helpers/gossip"

/**
 * Follow-ups to the gossip input bounds (src/gossip/ws.ts, SPEC.md "Gossip
 * input bounds"):
 *
 *  - A dial refused by a full node (1013, "try again later") must back off.
 *    The socket OPENS before the refusal, and the open reset the backoff, so a
 *    refused peer re-dialled every PEER_RECONNECT_MIN_MS for ever.
 *  - The per-socket frame budget must refill on a monotonic clock. It read
 *    Date.now(), so a wall clock stepped backwards froze the refill and an
 *    honest peer's frames were dropped for as long as the step.
 *
 * Ports 9791-9793 are used by no other test file.
 */
function wait(ms: number) {
  return new Promise((res) => setTimeout(res, ms))
}

function txEnvelope(n: number): string {
  return JSON.stringify({ type: "tx", payloadHex: Buffer.from(String(n)).toString("hex") })
}

/** A bare server that closes every connection it accepts with `code`. */
function refusingPeer(port: number, code: number) {
  const seenAt: number[] = []
  const server = new WebSocketServer({ port })
  server.on("connection", (ws) => {
    seenAt.push(Date.now())
    ws.on("error", () => {})
    ws.close(code, "test")
  })
  return {
    seenAt,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

describe("gossip bounds: review follow-ups", () => {
  it("backs off a peer that keeps refusing with 1013 instead of re-dialling at the minimum", async () => {
    const peer = refusingPeer(9791, 1013)
    const node = startGossipNode(9792, ["ws://127.0.0.1:9791"])
    try {
      await waitUntil(() => peer.seenAt.length >= 3, "three dials of the refusing peer", 8000)
      const firstGap = peer.seenAt[1] - peer.seenAt[0]
      const secondGap = peer.seenAt[2] - peer.seenAt[1]
      // Backoff doubles from PEER_RECONNECT_MIN_MS (500, then 1000, plus up to
      // 25% jitter). Without the fix every gap is 500-625ms.
      expect(firstGap).toBeGreaterThanOrEqual(PEER_RECONNECT_MIN_MS - 50)
      expect(secondGap).toBeGreaterThanOrEqual(2 * PEER_RECONNECT_MIN_MS - 50)
    } finally {
      await closeAll(node, peer)
    }
  }, 15000)

  it("still re-dials at the minimum after an ordinary close, which is not a refusal", async () => {
    const peer = refusingPeer(9793, 1000)
    const node = startGossipNode(9792, ["ws://127.0.0.1:9793"])
    try {
      await waitUntil(() => peer.seenAt.length >= 3, "three dials of the closing peer", 8000)
      const secondGap = peer.seenAt[2] - peer.seenAt[1]
      // an open link resets the backoff: the second gap is the minimum again
      expect(secondGap).toBeLessThan(2 * PEER_RECONNECT_MIN_MS - 50)
    } finally {
      await closeAll(node, peer)
    }
  }, 15000)

  it("keeps refilling a socket's frame budget when the wall clock steps backwards", async () => {
    const node = startGossipNode(9792, [], { maxFrameBurst: 1, maxFramesPerSecond: 50 })
    const delivered: string[] = []
    node.on("tx", (m) => delivered.push(new TextDecoder().decode(m.payload)))
    const sock = new WebSocket("ws://127.0.0.1:9792")
    sock.on("error", () => {})
    const realNow = Date.now.bind(Date)
    try {
      await new Promise((res) => sock.once("open", res))
      sock.send(txEnvelope(1))
      await waitUntil(() => delivered.length >= 1, "the first frame")

      // NTP steps the wall clock back an hour; time itself keeps going
      jest.spyOn(Date, "now").mockImplementation(() => realNow() - 3_600_000)
      // 200ms at 50 frames/s refills the one-frame bucket many times over
      await wait(200)
      sock.send(txEnvelope(2))
      await waitUntil(() => delivered.length >= 2, "a frame after the bucket has refilled", 2000)
      expect(delivered).toEqual(["1", "2"])
    } finally {
      jest.restoreAllMocks()
      await closeAll(
        {
          close: () =>
            new Promise<void>((resolve) => {
              if (sock.readyState === WebSocket.CLOSED) return resolve()
              sock.once("close", () => resolve())
              sock.close()
            }),
        },
        node
      )
    }
  }, 10000)
})
