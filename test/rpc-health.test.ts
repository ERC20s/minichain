import { request } from "http"
import { startRpcServer, rpcMethodNames, RPC_METHOD_NAMES } from "../src/rpc/server"

function httpGet(port: number, path = "/health") {
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

describe("GET /health lightweight probe", () => {
  it("returns ok, writesEnabled and methods", async () => {
    const stub: any = {
      tip: { height: 0 },
      validators: [],
      balances: { balanceOf: () => 0 },
      nonces: { lastNonce: () => undefined },
    }
    const handle = startRpcServer(stub, 0)
    const port = await handle.ready()
    try {
      const res = await httpGet(port, "/health")
      expect(res.status).toBe(200)
      expect(res.body).toBeTruthy()
      expect(res.body.ok).toBe(true)
      expect(res.body.writesEnabled).toBe(handle.writesEnabled)
      expect(res.body.methods).toEqual(rpcMethodNames(handle.writesEnabled))
    } finally {
      await handle.close()
    }
  })
})
