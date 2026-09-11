import { request } from "http"
import { startRpcServer, RPC_METHOD_NAMES } from "../src/rpc/server"

function httpGet(port: number, path = "/metrics") {
  return new Promise<{ status: number; body: any; text: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "GET", path }, (res) => {
      const chunks: Buffer[] = []
      res.on("data", (c: Buffer) => chunks.push(c))
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8")
        let parsed: any = null
        try {
          parsed = text ? JSON.parse(text) : null
        } catch (e) {
          parsed = null
        }
        resolve({ status: res.statusCode || 0, body: parsed, text })
      })
    })
    req.on("error", reject)
    req.end()
  })
}

function httpPost(port: number, body: object, host = "127.0.0.1") {
  const payload = JSON.stringify(body)
  return new Promise<{ status: number; body: any; text: string }>((resolve, reject) => {
    const req = request({ host, port, method: "POST", path: "/", headers: { "Content-Type": "application/json" } }, (res) => {
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

describe("GET /metrics and GET /health reflect write-method availability", () => {
  it("reports writes disabled when bound to a non-loopback address (0.0.0.0)", async () => {
    const stub: any = {
      tip: { height: 0 },
      validators: [],
      balances: { balanceOf: () => 0 },
      nonces: { lastNonce: () => undefined },
    }
    const handle = startRpcServer(stub, 0, "0.0.0.0")
    const port = await handle.ready()
    try {
      expect(handle.writesEnabled).toBe(false)

      const metrics = await httpGet(port, "/metrics")
      expect(metrics.status).toBe(200)
      expect(metrics.body).toBeTruthy()
      expect(metrics.body.writesEnabled).toBe(false)
      expect(Array.isArray(metrics.body.methods)).toBe(true)
      expect(metrics.body.methods.indexOf("chain_sendTransaction")).toBe(-1)

      const health = await httpGet(port, "/health")
      expect(health.status).toBe(200)
      expect(health.body).toBeTruthy()
      expect(health.body.writesEnabled).toBe(false)
      expect(Array.isArray(health.body.methods)).toBe(true)
      expect(health.body.methods.indexOf("chain_sendTransaction")).toBe(-1)

      // Ensure a read method still works over POST
      const rpc = await call(port, "chain_height")
      expect(rpc.status).toBe(200)
      expect(rpc.body).toBeTruthy()
      expect(rpc.body.result).toBeTruthy()
      expect(rpc.body.result.height).toBe(0)
    } finally {
      await handle.close()
    }
  })

  it("reports writes disabled on loopback when the node lacks submitTransaction", async () => {
    const stub: any = {
      tip: { height: 1 },
      validators: [],
      balances: { balanceOf: () => 0 },
      nonces: { lastNonce: () => undefined },
      // no submitTransaction provided
    }
    const handle = startRpcServer(stub, 0, "127.0.0.1")
    const port = await handle.ready()
    try {
      expect(handle.writesEnabled).toBe(false)

      const metrics = await httpGet(port, "/metrics")
      expect(metrics.status).toBe(200)
      expect(metrics.body).toBeTruthy()
      expect(metrics.body.writesEnabled).toBe(false)
      expect(metrics.body.methods.indexOf("chain_sendTransaction")).toBe(-1)

      const health = await httpGet(port, "/health")
      expect(health.status).toBe(200)
      expect(health.body).toBeTruthy()
      expect(health.body.writesEnabled).toBe(false)
      expect(health.body.methods.indexOf("chain_sendTransaction")).toBe(-1)

      // Read still works
      const rpc = await call(port, "chain_height")
      expect(rpc.status).toBe(200)
      expect(rpc.body).toBeTruthy()
      expect(rpc.body.result).toBeTruthy()
      expect(rpc.body.result.height).toBe(1)

      // And the methods list matches the exported RPC_METHOD_NAMES for the current writesEnabled
      expect(Array.isArray(metrics.body.methods)).toBe(true)
      expect(metrics.body.methods).toEqual(RPC_METHOD_NAMES)
    } finally {
      await handle.close()
    }
  })
})
