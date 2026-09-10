import { request } from "http"
import { Node } from "../src/node"
import { Block, blockHash, createBlock } from "../src/block"
import { canonicalBlockEncoding } from "../src/coding/serialize"
import { Keypair, sign } from "../src/crypto/ed25519"
import {
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  RPC_METHOD_NAMES,
  startRpcServer,
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

function signBlock(blk: Block, keypair: Keypair): Uint8Array {
  const msg = canonicalBlockEncoding({
    parentHash: blk.parentHash,
    height: blk.height,
    timestamp: blk.timestamp,
    merkleRoot: blk.merkleRoot,
    proposerPublicKey: keypair.publicKey,
  })
  return sign(msg, keypair.secretKey)
}

describe("chain_getBlockRange RPC", () => {
  const proposer = account(31)
  const validators = [{ publicKey: accountHex(31), stake: 100 }]
  const opening = funded([21], 1000)
  const genesis = createBlock("0x00", 0, [])

  let node: Node
  let peer: Node
  let rpc: any
  let port = 0

  beforeAll(async () => {
    node = new Node(9112, [], genesis, validators, opening)
    await wait(60)
    peer = new Node(9111, ["ws://127.0.0.1:9112"], genesis, [], opening)
    rpc = startRpcServer(node, 0)
    port = await rpc.ready()
    await wait(120)
  }, 10000)

  afterAll(async () => {
    await rpc.close()
    try { peer.close() } catch (e) {}
    try { node.close() } catch (e) {}
    await wait(50)
  })

  it("returns multiple consecutive blocks when held", async () => {
    const blk1 = createBlock(blockHash(genesis), 1, [signedTx(21, { recipient: 'bob', amount: 10, nonce: 7 })])
    const blk2 = createBlock(blockHash(blk1), 2, [signedTx(21, { recipient: 'carol', amount: 5, nonce: 8 })])
    peer.broadcastBlock(blk1, signBlock(blk1, proposer), proposer.publicKey)
    peer.broadcastBlock(blk2, signBlock(blk2, proposer), proposer.publicKey)
    await wait(300)

    const res = await call(port, "chain_getBlockRange", { from: 1, max: 2 })
    expect(res.status).toBe(200)
    expect(res.body.result.from).toBe(1)
    expect(res.body.result.requested).toBe(2)
    expect(res.body.result.returned).toBeGreaterThanOrEqual(1)
    expect(Array.isArray(res.body.result.blocks)).toBe(true)
    if (res.body.result.returned > 0) {
      expect(res.body.result.blocks.length).toBe(res.body.result.returned)
      expect(res.body.result.blocks[0].height).toBe(1)
    }
  }, 10000)

  it("returns empty blocks array for an unheld from (e.g. genesis)", async () => {
    const res = await call(port, "chain_getBlockRange", [0, 2])
    expect(res.status).toBe(200)
    expect(res.body.result.from).toBe(0)
    expect(res.body.result.returned).toBe(0)
    expect(Array.isArray(res.body.result.blocks)).toBe(true)
    expect(res.body.result.blocks.length).toBe(0)
  })

  it("rejects bad params with RPC_INVALID_PARAMS", async () => {
    const neg = await call(port, "chain_getBlockRange", { from: -1, max: 2 })
    expect(neg.body.error.code).toBe(RPC_INVALID_PARAMS)

    const frac = await call(port, "chain_getBlockRange", { from: 1.5, max: 2 })
    expect(frac.body.error.code).toBe(RPC_INVALID_PARAMS)

    const missing = await call(port, "chain_getBlockRange", {})
    expect(missing.body.error.code).toBe(RPC_INVALID_PARAMS)

    const wrong = await call(port, "chain_getBlockRange", { from: 1, max: 0 })
    expect(wrong.body.error.code).toBe(RPC_INVALID_PARAMS)
  })

  it("enforces the RPC_BLOCK_RANGE_MAX cap", async () => {
    const res = await call(port, "chain_getBlockRange", { from: 1, max: 100 })
    expect(res.status).toBe(200)
    expect(res.body.result.requested).toBe(100)
    expect(res.body.result.returned).toBeLessThanOrEqual(32)
  })
})