import { request } from "http"
import { startRpcServer } from "../src/rpc/server"

function httpPost(port: number, body: object) {
  const payload = JSON.stringify(body)
  return new Promise<{ status: number; body: any; text: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "POST", path: "/", headers: { "Content-Type": "application/json" } }, (res) => {
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

describe("chain_store_capacity RPC", () => {
  it("returns supported:true and the node's capacity when chain is present with capacity", async () => {
    const stub: any = {
      tip: { height: 10 },
      validators: [],
      balances: { balanceOf: () => 0 },
      nonces: { lastNonce: () => undefined },
      chain: { get: (h: number) => undefined, capacity: 42 },
    }
    const handle = startRpcServer(stub, 0)
    const port = await handle.ready()
    try {
      const res = await call(port, "chain_store_capacity")
      expect(res.status).toBe(200)
      expect(res.body).toBeTruthy()
      expect(res.body.result).toBeTruthy()
      expect(res.body.result.supported).toBe(true)
      expect(res.body.result.capacity).toBe(42)
    } finally {
      await handle.close()
    }
  })

  it("returns supported:false when node offers no chain store", async () => {
    const stub: any = {
      tip: { height: 10 },
      validators: [],
      balances: { balanceOf: () => 0 },
      nonces: { lastNonce: () => undefined },
      // no chain property
    }
    const handle = startRpcServer(stub, 0)
    const port = await handle.ready()
    try {
      const res = await call(port, "chain_store_capacity")
      expect(res.status).toBe(200)
      expect(res.body).toBeTruthy()
      expect(res.body.result).toBeTruthy()
      expect(res.body.result.supported).toBe(false)
    } finally {
      await handle.close()
    }
  })
})
