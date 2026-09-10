import { request } from "http"
import { Node } from "../src/node"
import { createBlock, blockHash, Block } from "../src/block"
import { Keypair, sign } from "../src/crypto/ed25519"
import { canonicalBlockEncoding } from "../src/coding/serialize"
import { account, accountHex, funded, signedTx } from "./helpers/signed-tx"
import { startRpcServer } from "../src/rpc/server"
import { transactionId } from "../src/state/mempool"

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

describe("chain_getTransaction RPC", () => {
  const proposer = account(31)
  const validators = [{ publicKey: accountHex(31), stake: 100 }]
  const opening = funded([21], 1000)
  const genesis = createBlock("0x00", 0, [])

  let node: Node
  let peer: Node
  let rpcPort = 0
  let rpcHandle: any

  beforeAll(async () => {
    node = new Node(9122, [], genesis, validators, opening)
    await wait(60)
    peer = new Node(9121, ["ws://127.0.0.1:9122"], genesis, [], opening)
    rpcHandle = startRpcServer(node, 0)
    rpcPort = await rpcHandle.ready()
    await wait(120)
  }, 10000)

  afterAll(async () => {
    try {
      await rpcHandle.close()
    } catch (e) {}
    try {
      peer.close()
    } catch (e) {}
    try {
      node.close()
    } catch (e) {}
    await wait(50)
  })

  it("finds a transaction in the mempool", async () => {
    const tx = signedTx(21, { recipient: "bob", amount: 10, nonce: 8 })
    const admitted = node.submitTransaction(tx)
    expect(admitted.admitted).toBe(true)
    const id = transactionId(tx)

    const res = await call(rpcPort, "chain_getTransaction", { id })
    expect(res.status).toBe(200)
    expect(res.body.result.found).toBe(true)
    expect(res.body.result.location).toBe("mempool")
    expect(res.body.result.id).toBe(id)
    expect(res.body.result.transaction).toEqual(tx)

    // cleanup
    node.mempool.clear()
  })

  it("finds a transaction in a sealed block", async () => {
    const tx = signedTx(21, { recipient: "carol", amount: 7, nonce: 9 })
    const blk = createBlock(blockHash(genesis), 1, [tx])
    const sig = signBlock(blk, proposer)
    peer.broadcastBlock(blk, sig, proposer.publicKey)
    await wait(250)

    const id = transactionId(tx)
    const res = await call(rpcPort, "chain_getTransaction", [id])
    expect(res.status).toBe(200)
    expect(res.body.result.found).toBe(true)
    expect(res.body.result.location).toBe("chain")
    expect(res.body.result.height).toBe(1)
    expect(res.body.result.index).toBe(0)
    expect(res.body.result.transaction).toEqual(tx)
  }, 10000)

  it("answers found: false for an unknown id", async () => {
    const res = await call(rpcPort, "chain_getTransaction", { id: "0".repeat(64) })
    expect(res.status).toBe(200)
    expect(res.body.result).toEqual({ found: false, id: "0".repeat(64) })
  })
})
