import { request } from "http"
import { startRpcServer, requestsHandled, internalErrors } from "../src/rpc/server"

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

describe("GET /metrics probe", () => {
  it("returns the expected JSON shape and does not double-count requests", async () => {
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
      const first = await httpGet(port, "/metrics")
      expect(first.status).toBe(200)
      expect(first.body).toBeTruthy()
      expect(first.body.ok).toBe(true)
      expect(typeof first.body.pid).toBe("number")
      expect(typeof first.body.uptimeMs).toBe("number")
      expect(typeof first.body.requestsHandled).toBe("number")
      expect(typeof first.body.internalErrors).toBe("number")
      expect(first.body.tipHeight).toBe(0)
      expect(first.body.mempoolEnabled).toBe(true)
      expect(first.body.mempoolSize).toBe(0)

      // POST a normal RPC call and ensure requestsHandled increments by 1 only
      const before = first.body.requestsHandled
      const rpc = await call(port, "chain_height")
      expect(rpc.status).toBe(200)
      const after = (await httpGet(port, "/metrics")).body.requestsHandled
      expect(after - before).toBe(1)

      // A GET /metrics itself also increments requestsHandled by 1
      const again = await httpGet(port, "/metrics")
      const againNum = again.body.requestsHandled
      expect(againNum - after).toBe(1)
    } finally {
      await handle.close()
    }
  })
})
