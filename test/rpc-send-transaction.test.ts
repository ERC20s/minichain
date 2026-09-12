import { request } from "http"
import { startRpcServer, RPC_METHOD_NOT_FOUND } from "../src/rpc/server"

function http(port: number, body: string | object, host = "127.0.0.1", headers: Record<string,string|number> = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body)
  const requestHeaders: Record<string, any> = { "Content-Type": "application/json" }
  for (const k of Object.keys(headers)) requestHeaders[k] = String(headers[k])
  return new Promise<{ status: number; body: any; text: string }>((resolve, reject) => {
    const req = request(
      { host, port, method: "POST", path: "/", headers: requestHeaders },
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
    req.write(payload)
    req.end()
  })
}

function call(port: number, method: string, params?: unknown, id: any = 1, headers: Record<string,string|number> = {}) {
  const body: Record<string, unknown> = { jsonrpc: "2.0", method, id }
  if (params !== undefined) body.params = params
  return http(port, body, undefined, headers)
}

describe("chain_sendTransaction: focused behaviour tests", () => {
  it("refuses write on a non-loopback bind with reason 'not-loopback'", async () => {
    const stub = { tip: { height: 0 }, validators: [], balances: { balanceOf: () => 0 }, nonces: { lastNonce: () => undefined } }
    const handle = startRpcServer(stub as any, 0, "0.0.0.0")
    const port = await handle.ready()
    try {
      expect(handle.writesEnabled).toBe(false)
      const tx = { foo: "bar" }
      const ans = await call(port, "chain_sendTransaction", { transaction: tx })
      expect(ans.status).toBe(400)
      expect(ans.body).toBeTruthy()
      expect(ans.body.error).toBeTruthy()
      expect(ans.body.error.code).toBe(RPC_METHOD_NOT_FOUND)
      expect(ans.body.error.data).toBeTruthy()
      expect(ans.body.error.data.reason).toBe("not-loopback")
    } finally {
      await handle.close()
    }
  })

  it("answers unsupported when the node lacks submitTransaction on a loopback bind", async () => {
    const stub = { tip: { height: 0 }, validators: [], balances: { balanceOf: () => 0 }, nonces: { lastNonce: () => undefined } }
    const handle = startRpcServer(stub as any, 0 /* port */, "127.0.0.1")
    const port = await handle.ready()
    try {
      // writesEnabled is false because submitTransaction is missing
      expect(handle.writesEnabled).toBe(false)
      const tx = { some: "tx" }
      const ans = await call(port, "chain_sendTransaction", { transaction: tx })
      expect(ans.status).toBe(400)
      expect(ans.body).toBeTruthy()
      expect(ans.body.error).toBeTruthy()
      expect(ans.body.error.code).toBe(RPC_METHOD_NOT_FOUND)
      expect(ans.body.error.data).toBeTruthy()
      expect(ans.body.error.data.reason).toBe("unsupported")
    } finally {
      await handle.close()
    }
  })

  it("requires X-Write-Token or Authorization: Bearer when RPC_WRITE_TOKEN is set", async () => {
    const token = "s3cr3t"
    const old = process.env.RPC_WRITE_TOKEN
    process.env.RPC_WRITE_TOKEN = token
    let seenTx: any = null
    const stub: any = {
      tip: { height: 0 },
      validators: [],
      balances: { balanceOf: () => 0 },
      nonces: { lastNonce: () => undefined },
      submitTransaction: (tx: any) => {
        seenTx = tx
        return { admitted: true, id: "okid" }
      },
    }
    const handle = startRpcServer(stub as any, 0)
    const port = await handle.ready()
    try {
      expect(handle.writesEnabled).toBe(true)
      const tx = { guarded: "tx" }
      const ansMissing = await call(port, "chain_sendTransaction", { transaction: tx })
      expect(ansMissing.status).toBe(401)
      expect(ansMissing.body).toBeTruthy()
      expect(ansMissing.body.error).toBeTruthy()
      expect(ansMissing.body.error.data).toBeTruthy()
      expect(ansMissing.body.error.data.reason).toBe("unauthorised")

      const ansWrong = await call(port, "chain_sendTransaction", { transaction: tx }, 1, { "X-Write-Token": "wrong" })
      expect(ansWrong.status).toBe(401)
      expect(ansWrong.body).toBeTruthy()
      expect(ansWrong.body.error).toBeTruthy()
      expect(ansWrong.body.error.data).toBeTruthy()
      expect(ansWrong.body.error.data.reason).toBe("unauthorised")

      const ansOk = await call(port, "chain_sendTransaction", { transaction: tx }, 1, { "X-Write-Token": token })
      expect(ansOk.status).toBe(200)
      expect(ansOk.body).toBeTruthy()
      expect(ansOk.body.result).toBeTruthy()
      expect(ansOk.body.result.admitted).toBe(true)
      expect(seenTx).toEqual(tx)

      // Authorization: Bearer should also be accepted
      const ansAuth = await call(port, "chain_sendTransaction", { transaction: tx }, 1, { "Authorization": `Bearer ${token}` })
      expect(ansAuth.status).toBe(200)
      expect(ansAuth.body).toBeTruthy()
      expect(ansAuth.body.result).toBeTruthy()
      expect(ansAuth.body.result.admitted).toBe(true)
    } finally {
      await handle.close()
      if (old === undefined) delete process.env.RPC_WRITE_TOKEN
      else process.env.RPC_WRITE_TOKEN = old
    }
  })

  it("accepts a transaction when loopback and submitTransaction returns an admission result", async () => {
    const admittedId = "abcd1234"
    let seenTx: any = null
    const stub: any = {
      tip: { height: 0 },
      validators: [],
      balances: { balanceOf: () => 0 },
      nonces: { lastNonce: () => undefined },
      submitTransaction: (tx: any) => {
        seenTx = tx
        return { admitted: true, id: admittedId }
      },
    }

    const handle = startRpcServer(stub as any, 0)
    const port = await handle.ready()
    try {
      expect(handle.writesEnabled).toBe(true)
      const tx = { hello: "world" }
      const ans = await call(port, "chain_sendTransaction", { transaction: tx })
      expect(ans.status).toBe(200)
      expect(ans.body).toBeTruthy()
      expect(ans.body.result).toBeTruthy()
      expect(ans.body.result.admitted).toBe(true)
      expect(ans.body.result.id).toBe(admittedId)
      // The stub saw the same transaction object we sent
      expect(seenTx).toEqual(tx)
    } finally {
      await handle.close()
    }
  })
})
