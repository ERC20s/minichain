import { request } from "http"
import { Node } from "../src/node"
import { createBlock } from "../src/block"
import { Keypair, sign } from "../src/crypto/ed25519"
import {
  RPC_INVALID_PARAMS,
  startRpcServer,
  rpcMethodNames,
} from "../src/rpc/server"
import { account, accountHex, funded, signedTx } from "./helpers/signed-tx"

function wait(ms: number) {
  return new Promise((res) => setTimeout(res, ms))
}

type RpcAnswer = { status: number; body: any; text: string }

function http(
  port: number,
  body: string | object,
  method = "POST",
  headers: Record<string, string> = {}
): Promise<RpcAnswer> {
  const payload = typeof body === "string" ? body : JSON.stringify(body)
  return new Promise((resolve, reject) => {
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

function call(port: number, method: string, params?: unknown, id: any = 1): Promise<RpcAnswer> {
  const body: Record<string, unknown> = { jsonrpc: "2.0", method, id }
  if (params !== undefined) body.params = params
  return http(port, body)
}

function signBlock(blk: any, keypair: Keypair): Uint8Array {
  const msg = new TextEncoder().encode(JSON.stringify({
    parentHash: blk.parentHash,
    height: blk.height,
    timestamp: blk.timestamp,
    merkleRoot: blk.merkleRoot,
    proposerPublicKey: keypair.publicKey,
  }))
  return sign(msg, keypair.secretKey)
}

describe("chain_mempool includeTransactions", () => {
  const proposer = account(31)
  const validators = [{ publicKey: accountHex(31), stake: 100 }]
  const opening = funded([21], 1000)
  const genesis = createBlock("0x00", 0, [])

  let node: Node
  let peer: Node
  let rpcPort = 0
  let rpc: any

  beforeAll(async () => {
    node = new Node(9112, [], genesis, validators, opening)
    await wait(60)
    peer = new Node(9111, ["ws://127.0.0.1:9112"], genesis, [], opening)
    rpc = startRpcServer(node, 0)
    rpcPort = await rpc.ready()
    await wait(120)
  }, 10000)

  afterAll(async () => {
    await rpc.close()
    try { peer.close() } catch (e) {}
    try { node.close() } catch (e) {}
    await wait(50)
  })

  it("default returns ids only and still forbids params", async () => {
    const empty = await call(rpcPort, "chain_mempool")
    expect(empty.status).toBe(200)
    expect(empty.body.result).toEqual({ enabled: true, size: 0, pending: [], truncated: false })

    const tx = signedTx(21, { recipient: "bob", amount: 10, nonce: 8 })
    const admitted = node.submitTransaction(tx)
    expect(admitted.admitted).toBe(true)

    const pooled = await call(rpcPort, "chain_mempool")
    expect(pooled.body.result.enabled).toBe(true)
    expect(pooled.body.result.size).toBe(1)
    expect(pooled.body.result.pending).toEqual(node.mempool.ids())

    const wrong = await call(rpcPort, "chain_mempool", { account: accountHex(21) })
    expect(wrong.body.error.code).toBe(RPC_INVALID_PARAMS)

    node.mempool.clear()
  }, 10000)

  it("returns transactions when requested", async () => {
    const tx = signedTx(21, { recipient: "bob", amount: 10, nonce: 8 })
    const admitted = node.submitTransaction(tx)
    expect(admitted.admitted).toBe(true)

    const raw = await call(rpcPort, "chain_mempool", { includeTransactions: true })
    expect(raw.status).toBe(200)
    const res = raw.body.result
    expect(res.enabled).toBe(true)
    expect(res.size).toBe(1)
    expect(res.pending).toEqual(node.mempool.ids())
    expect(Array.isArray(res.transactions)).toBe(true)
    expect(res.transactions.length).toBe(1)
    // the transaction object should deep-equal the stored transaction
    expect(res.transactions[0]).toEqual(node.mempool.get(res.pending[0]))

    node.mempool.clear()
  })

  it("accepts a positional boolean true", async () => {
    const tx = signedTx(21, { recipient: "bob", amount: 10, nonce: 8 })
    const admitted = node.submitTransaction(tx)
    expect(admitted.admitted).toBe(true)

    const raw = await call(rpcPort, "chain_mempool", [true])
    expect(raw.status).toBe(200)
    expect(Array.isArray(raw.body.result.transactions)).toBe(true)
    node.mempool.clear()
  })

  it("rejects a non-boolean positional parameter", async () => {
    const bad = await call(rpcPort, "chain_mempool", [123])
    expect(bad.body.error.code).toBe(RPC_INVALID_PARAMS)
  })

})
