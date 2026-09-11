import { request } from "http"
import { startRpcServer } from "../src/rpc/server"

function httpGet(port: number, path = "/metrics") {
  return new Promise<{ status: number; headers: any; body: any; text: string }>((resolve, reject) => {
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
        resolve({ status: res.statusCode || 0, headers: res.headers, body: parsed, text })
      })
    })
    req.on("error", reject)
    req.end()
  })
}

function httpOptions(port: number, path = "/") {
  return new Promise<{ status: number; headers: any }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "OPTIONS", path, headers: { "Access-Control-Request-Headers": "X-Test-Header" } }, (res) => {
      // no body expected
      res.on("data", () => {})
      res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers }))
    })
    req.on("error", reject)
    req.end()
  })
}

function httpPost(port: number, body: object) {
  const payload = JSON.stringify(body)
  return new Promise<{ status: number; headers: any; body: any; text: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "POST", path: "/", headers: { "Content-Type": "application/json" } }, (res) => {
      const chunks: Buffer[] = []
      res.on("data", (c: Buffer) => chunks.push(c))
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8")
        let parsed: any = null
        try { parsed = text ? JSON.parse(text) : null } catch (e) { parsed = null }
        resolve({ status: res.statusCode || 0, headers: res.headers, body: parsed, text })
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

describe("CORS headers and preflight", () => {
  it("exposes Access-Control-Allow-Origin on GET /metrics and POST /", async () => {
    const stub: any = {
      tip: { height: 0 },
      validators: [],
      balances: { balanceOf: () => 0 },
      nonces: { lastNonce: () => undefined },
      mempool: { size: 0, ids: () => [], get: () => undefined },
    }
    const handle = startRpcServer(stub, 0)
    const port = await handle.ready()
    try {
      const g = await httpGet(port, "/metrics")
      expect(g.status).toBe(200)
      expect(g.headers["access-control-allow-origin"]).toBe("*")

      const rpc = await call(port, "chain_height")
      expect(rpc.status).toBe(200)
      expect(rpc.headers["access-control-allow-origin"]).toBe("*")
    } finally {
      await handle.close()
    }
  })

  it("responds to OPTIONS with 204 and CORS/Allow headers", async () => {
    const stub: any = {
      tip: { height: 0 },
      validators: [],
      balances: { balanceOf: () => 0 },
      nonces: { lastNonce: () => undefined },
    }
    const handle = startRpcServer(stub, 0)
    const port = await handle.ready()
    try {
      const opts = await httpOptions(port, "/")
      expect(opts.status).toBe(204)
      expect(opts.headers["access-control-allow-methods"]).toBe("POST, OPTIONS")
      expect(opts.headers["access-control-allow-headers"]).toBeDefined()
    } finally {
      await handle.close()
    }
  })
})
