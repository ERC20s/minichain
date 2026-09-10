import { request } from "http"
import { Node } from "../src/node"
import { createBlock } from "../src/block"
import { startRpcServer } from "../src/rpc/server"
import { funded } from "./helpers/signed-tx"

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

describe("GET /metrics endpoint", () => {
  it("returns the expected shape and reflects mempool presence", async () => {
    // Small fixture: a Node with no peers and a genesis block
    const opening = funded([], 0)
    const genesis = createBlock("0x00", 0, [])
    const node = new Node(9200, [], genesis, [], opening)
    const handle = startRpcServer(node, 0)
    const port = await handle.ready()
    try {
      const res = await httpGet(port, "/metrics")
      expect(res.status).toBe(200)
      expect(res.body).toBeTruthy()
      // Basic process info
      expect(typeof res.body.pid).toBe("number")
      expect(typeof res.body.uptimeMs).toBe("number")
      // Counters present
      expect(typeof res.body.requestsHandled).toBe("number")
      expect(typeof res.body.internalErrors).toBe("number")
      // Tip and mempool
      expect(typeof res.body.tipHeight).toBe("number")
      expect(res.body.mempoolEnabled).toBe(false)
      expect(res.body.mempoolSize).toBe(0)
      // Writes flag
      expect(res.body.writesEnabled).toBe(handle.writesEnabled)
    } finally {
      await handle.close()
      try { node.close() } catch (e) {}
    }
  })
})
