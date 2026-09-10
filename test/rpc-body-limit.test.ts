import { request } from "http"
import { createBlock } from "../src/block"
import { startRpcServer, MAX_RPC_BODY_BYTES } from "../src/rpc/server"

function rawHttp(port: number, payload: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: any; text: string }>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method: "POST", path: "/", headers },
      (res) => {
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
      }
    )
    req.on("error", reject)
    // write the payload and end; caller controls headers (including whether
    // to include a Content-Length) so this can exercise chunked and declared
    // length branches.
    req.write(payload)
    req.end()
  })
}

describe("JSON-RPC body size enforcement", () => {
  const genesis = createBlock("0x00", 0, [])
  const stub = {
    tip: genesis,
    validators: [],
    balances: { balanceOf: () => 0 },
    nonces: { lastNonce: () => undefined },
  }
  let handle: ReturnType<typeof startRpcServer>
  let port = 0

  beforeAll(async () => {
    handle = startRpcServer(stub as any, 0)
    port = await handle.ready()
  })

  afterAll(async () => {
    if (handle) await handle.close()
  })

  it("returns 413 when the actual streamed body exceeds MAX_RPC_BODY_BYTES (chunked)", async () => {
    // Send a chunked request (no Content-Length header) whose bytes exceed
    // the cap as they arrive. The server enforces the cap on the bytes streamed
    // and replies 413 with the expected JSON-RPC error message.
    const bigBodyObj = {
      jsonrpc: "2.0",
      method: "chain_getBalance",
      params: { account: "x".repeat(MAX_RPC_BODY_BYTES + 1024) },
      id: 1,
    }
    const payload = JSON.stringify(bigBodyObj)
    // Do not set Content-Length so Node uses chunked transfer encoding.
    const res = await rawHttp(port, payload, { "Content-Type": "application/json" })
    expect(res.status).toBe(413)
    expect(res.body).toBeTruthy()
    expect(res.body.error).toBeTruthy()
    expect(res.body.error.message).toBe(`request body exceeds ${MAX_RPC_BODY_BYTES} bytes`)
  })

  it("returns 413 when the declared Content-Length exceeds MAX_RPC_BODY_BYTES (drops chunks)", async () => {
    // Announce a length larger than the cap but send only a small body. The
    // server refuses based on the declared length and returns 413 without
    // buffering the payload.
    const bodyObj = { jsonrpc: "2.0", method: "chain_height", id: 1 }
    const payload = JSON.stringify(bodyObj)
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": String(MAX_RPC_BODY_BYTES + 1),
    }
    const res = await rawHttp(port, payload, headers)
    expect(res.status).toBe(413)
    expect(res.body).toBeTruthy()
    expect(res.body.error).toBeTruthy()
    expect(res.body.error.message).toBe(`request body exceeds ${MAX_RPC_BODY_BYTES} bytes`)
  })
})
