import { request } from "http"
import { startRpcServer } from "../src/rpc/server"

/** Minimal HTTP helper used across the test suite style. */
function http(port: number, body: string | object, method = "POST", headers: Record<string, string> = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body)
  return new Promise<{ status: number; body: any; text: string }>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: "/",
        headers: { "Content-Type": "application/json", ...headers },
      },
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
    if (method !== "GET") req.write(payload)
    req.end()
  })
}

describe("JSON-RPC notification semantics", () => {
  it("acknowledges a read notification with 204 and does not execute the read", async () => {
    // A tip whose height getter records access; if the server executes the
    // read method for a notification the getter would run and flip the flag.
    let accessed = false
    const stub = {
      get tip() {
        accessed = true
        return { height: 0 }
      },
      validators: [],
      balances: { balanceOf: () => 0 },
      nonces: { lastNonce: () => undefined },
    }
    const server = startRpcServer(stub as any, 0)
    const port = await server.ready()

    const notification = await http(port, { jsonrpc: "2.0", method: "chain_height" })
    expect(notification.status).toBe(204)
    expect(notification.text).toBe("")
    // The read must not have been executed.
    expect(accessed).toBe(false)

    await server.close()
  })

  it("executes a write notification and returns 204 while discarding the result", async () => {
    let called = false
    let seenTx: any = null
    const stub = {
      tip: { height: 0 },
      validators: [],
      balances: { balanceOf: () => 0 },
      nonces: { lastNonce: () => undefined },
      submitTransaction(tx: any) {
        called = true
        seenTx = tx
        return { admitted: true, id: "deadbeef", reason: undefined }
      },
    }

    const server = startRpcServer(stub as any, 0)
    const port = await server.ready()

    const tx = { sender: "0x01", recipient: "bob", amount: 1, nonce: 1 }
    const notification = await http(port, { jsonrpc: "2.0", method: "chain_sendTransaction", params: { transaction: tx } })
    expect(notification.status).toBe(204)
    expect(notification.text).toBe("")
    // The write must have been executed on the node.
    expect(called).toBe(true)
    expect(seenTx).toEqual(tx)

    await server.close()
  })
})
