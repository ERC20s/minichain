import { startRpcServer, rpcMethodNames } from "../src/rpc/server"
import { startGossipNode } from "../src/gossip/ws"

function httpPost(port: number, body: object) {
  const payload = JSON.stringify(body)
  const { request } = require("http")
  return new Promise<{ status: number; body: any; text: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "POST", path: "/", headers: { "Content-Type": "application/json" } }, (res: any) => {
      const chunks: Buffer[] = []
      res.on("data", (c: Buffer) => chunks.push(c))
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8")
        let parsed: any = null
        try { parsed = text ? JSON.parse(text) : null } catch (e) { parsed = null }
        resolve({ status: res.statusCode || 0, body: parsed, text })
      })
    })
    req.on("error", reject)
    req.write(payload)
    req.end()
  })
}

function call(port: number, method: string, params?: unknown, id: any = 1) {
  const body: Record<string, unknown> = { jsonrpc: "2.0", method, id }
  if (params !== undefined) body.params = params
  return httpPost(port, body)
}

describe("chain_peers RPC", () => {
  it("returns supported: false when node offers no gossip peerCounts", async () => {
    const stub: any = {
      tip: { height: 0 },
      validators: [],
      balances: { balanceOf: () => 0 },
      nonces: { lastNonce: () => undefined },
    }
    const handle = startRpcServer(stub, 0)
    const port = await handle.ready()
    try {
      const res = await call(port, "chain_peers")
      expect(res.status).toBe(200)
      expect(res.body).toBeTruthy()
      expect(res.body.result).toBeTruthy()
      expect(res.body.result.supported).toBe(false)
    } finally {
      await handle.close()
    }
  })

  it("reports inbound and outbound counts when gossip is present", async () => {
    // start two gossip nodes that connect to each other
    const portA = 9701
    const portB = 9702
    const urlA = `ws://127.0.0.1:${portA}`
    const urlB = `ws://127.0.0.1:${portB}`

    const gossipA = startGossipNode(portA, [urlB])
    const gossipB = startGossipNode(portB, [urlA])

    // give the transports a moment to connect
    await new Promise((r) => setTimeout(r, 150))

    // node that wraps gossipA and exposes it via peerCounts
    const node: any = {
      tip: { height: 0 },
      validators: [],
      balances: { balanceOf: () => 0 },
      nonces: { lastNonce: () => undefined },
      peerCounts: () => gossipA.peerCounts(),
    }

    const handle = startRpcServer(node, 0)
    const port = await handle.ready()
    try {
      const res = await call(port, "chain_peers")
      expect(res.status).toBe(200)
      expect(res.body).toBeTruthy()
      const out = res.body.result
      expect(out.supported).toBe(true)
      expect(typeof out.inbound).toBe("number")
      expect(typeof out.outbound).toBe("number")
      expect(typeof out.total).toBe("number")
      // outbound should be at least 1 (we dialed urlB)
      expect(out.outbound).toBeGreaterThanOrEqual(1)
      // inbound should be at least 1 (gossipB connected to us)
      expect(out.inbound).toBeGreaterThanOrEqual(1)
      expect(out.total).toBe(out.inbound + out.outbound)
    } finally {
      await handle.close()
      gossipA.close()
      gossipB.close()
    }
  }, 2000)
})
