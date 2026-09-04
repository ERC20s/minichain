import { request } from "http"
import { Node } from "../src/node"
import { Block, blockHash, createBlock } from "../src/block"
import { canonicalBlockEncoding } from "../src/coding/serialize"
import { Keypair, sign } from "../src/crypto/ed25519"
import {
  MAX_RPC_BODY_BYTES,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NAMES,
  RPC_METHOD_NOT_FOUND,
  RPC_PARSE_ERROR,
  RPC_WRITE_METHOD_NAMES,
  RpcServerHandle,
  rpcMethodNames,
  startRpcServer,
} from "../src/rpc/server"
import { account, accountHex, funded, signedTx } from "./helpers/signed-tx"

/**
 * The JSON-RPC surface (src/rpc/server.ts) — its reads, its framing and its
 * transport. The one write method it serves on loopback has its own file,
 * test/rpc-submit.test.ts.
 *
 * What is pinned here:
 *  - the answers track the node's own state: height and tip follow an accepted
 *    block, balances and nonces match the ledgers src/node.ts commits;
 *  - the framing is strict JSON-RPC 2.0 and every error code fires;
 *  - the transport is POST-only and body-capped;
 *  - and no call moves the tip: the read table writes nothing at all, and the
 *    single write method reaches the mempool and never a block.
 *
 * The RPC servers bind port 0 (the OS picks a free port), so this file cannot
 * collide with another test file's ports; the two gossip ports it does fix,
 * 9111 and 9112, are used nowhere else in the suite.
 */
function wait(ms: number) {
  return new Promise((res) => setTimeout(res, ms))
}

type RpcAnswer = { status: number; body: any; text: string }

/** One HTTP call against the RPC server. `body` is sent verbatim if a string. */
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

/** A JSON-RPC call with the framing filled in. */
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

describe("read-only JSON-RPC server", () => {
  // The proposer is also the only staked validator, so a single-entry set always
  // elects it and the block below is judged on everything except the election.
  const proposer = account(31)
  const validators = [{ publicKey: accountHex(31), stake: 100 }]
  const opening = funded([21], 1000)
  const genesis = createBlock("0x00", 0, [])

  let node: Node
  let peer: Node
  let rpc: RpcServerHandle
  let port = 0

  beforeAll(async () => {
    node = new Node(9112, [], genesis, validators, opening)
    await wait(60)
    // The peer only exists to gossip a block INTO the node under test.
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

  it("binds a port and reports the genesis tip", async () => {
    expect(port).toBeGreaterThan(0)

    const height = await call(port, "chain_height")
    expect(height.status).toBe(200)
    expect(height.body).toEqual({ jsonrpc: "2.0", id: 1, result: { height: 0 } })

    const tip = await call(port, "chain_tip", undefined, "abc")
    expect(tip.status).toBe(200)
    expect(tip.body.id).toBe("abc")
    expect(tip.body.result).toEqual({
      hash: blockHash(genesis),
      parentHash: "0x00",
      height: 0,
      timestamp: genesis.timestamp,
      merkleRoot: genesis.merkleRoot,
      transactionCount: 0,
    })
  })

  it("reports balances, nonces and the staked set from the node's own state", async () => {
    const funded21 = await call(port, "chain_getBalance", { account: accountHex(21) })
    expect(funded21.body.result).toEqual({ account: accountHex(21), balance: 1000 })

    // Positional params are accepted too.
    const positional = await call(port, "chain_getBalance", [accountHex(21)])
    expect(positional.body.result.balance).toBe(1000)

    const stranger = await call(port, "chain_getBalance", { account: "nobody" })
    expect(stranger.body.result).toEqual({ account: "nobody", balance: 0 })

    // null, not 0: this account has spent no nonce at all.
    const nonce = await call(port, "chain_getNonce", { account: accountHex(21) })
    expect(nonce.body.result).toEqual({ account: accountHex(21), nonce: null })

    const set = await call(port, "chain_validators")
    expect(set.body.result).toEqual({
      validators: [{ publicKey: accountHex(31), stake: 100 }],
      totalStake: 100,
      enforced: true,
    })
  })

  it("follows the tip, the balances and the nonces after a block is accepted", async () => {
    const blk = createBlock(blockHash(genesis), 1, [
      signedTx(21, { recipient: "bob", amount: 40, nonce: 7 }),
    ])
    peer.broadcastBlock(blk, signBlock(blk, proposer), proposer.publicKey)
    await wait(250)

    // The node accepted it through the ordinary gossip path...
    expect(node.tip.height).toBe(1)

    const height = await call(port, "chain_height")
    expect(height.body.result).toEqual({ height: 1 })

    const tip = await call(port, "chain_tip")
    expect(tip.body.result.hash).toBe(blockHash(blk))
    expect(tip.body.result.parentHash).toBe(blockHash(genesis))
    expect(tip.body.result.height).toBe(1)
    expect(tip.body.result.merkleRoot).toBe(blk.merkleRoot)
    expect(tip.body.result.transactionCount).toBe(1)

    const sender = await call(port, "chain_getBalance", { account: accountHex(21) })
    expect(sender.body.result.balance).toBe(960)
    expect(sender.body.result.balance).toBe(node.balances.balanceOf(accountHex(21)))

    const recipient = await call(port, "chain_getBalance", { account: "bob" })
    expect(recipient.body.result.balance).toBe(40)

    const nonce = await call(port, "chain_getNonce", { account: accountHex(21) })
    expect(nonce.body.result.nonce).toBe(7)
    expect(nonce.body.result.nonce).toBe(node.nonces.lastNonce(accountHex(21)))
  }, 10000)

  it("reports the pending-transaction pool, read-only", async () => {
    const empty = await call(port, "chain_mempool")
    expect(empty.status).toBe(200)
    expect(empty.body.result).toEqual({ enabled: true, size: 0, pending: [], truncated: false })

    // Account 21 spent nonce 7 in the block above and still holds 960, so this
    // is signed, fresh and affordable: the node admits it to its own pool.
    const tx = signedTx(21, { recipient: "bob", amount: 10, nonce: 8 })
    const admitted = node.submitTransaction(tx)
    expect(admitted.admitted).toBe(true)

    const pooled = await call(port, "chain_mempool")
    expect(pooled.body.result.enabled).toBe(true)
    expect(pooled.body.result.size).toBe(1)
    expect(pooled.body.result.pending).toEqual(node.mempool.ids())
    expect(pooled.body.result.truncated).toBe(false)

    // it takes no parameters, and it cannot change the pool
    const wrong = await call(port, "chain_mempool", { account: accountHex(21) })
    expect(wrong.body.error.code).toBe(RPC_INVALID_PARAMS)
    expect(node.mempool.size).toBe(1)

    // a node without a pool is answered, not errored
    const stub = {
      tip: node.tip,
      validators: [],
      balances: { balanceOf: () => 0 },
      nonces: { lastNonce: () => undefined },
    }
    const handle = startRpcServer(stub, 0)
    const stubPort = await handle.ready()
    const none = await call(stubPort, "chain_mempool")
    expect(none.body.result).toEqual({ enabled: false, size: 0, pending: [], truncated: false })
    await handle.close()

    node.mempool.clear()
  }, 10000)

  it("answers -32700 for a body that is not JSON", async () => {
    const bad = await http(port, "{not json")
    expect(bad.status).toBe(400)
    expect(bad.body.error.code).toBe(RPC_PARSE_ERROR)
    expect(bad.body.id).toBeNull()
  })

  it("answers -32600 for bad framing, and refuses batches", async () => {
    const noVersion = await http(port, { method: "chain_height", id: 1 })
    expect(noVersion.body.error.code).toBe(RPC_INVALID_REQUEST)

    const wrongVersion = await http(port, { jsonrpc: "1.0", method: "chain_height", id: 1 })
    expect(wrongVersion.body.error.code).toBe(RPC_INVALID_REQUEST)

    const noMethod = await http(port, { jsonrpc: "2.0", id: 1 })
    expect(noMethod.body.error.code).toBe(RPC_INVALID_REQUEST)

    const notAnObject = await http(port, '"hello"')
    expect(notAnObject.body.error.code).toBe(RPC_INVALID_REQUEST)

    const batch = await http(port, [{ jsonrpc: "2.0", method: "chain_height", id: 1 }])
    expect(batch.body.error.code).toBe(RPC_INVALID_REQUEST)
    expect(batch.body.error.message).toMatch(/batch/i)

    const badId = await http(port, { jsonrpc: "2.0", method: "chain_height", id: { a: 1 } })
    expect(badId.body.error.code).toBe(RPC_INVALID_REQUEST)
  })

  it("answers -32601 for an unknown method and lists what it does answer", async () => {
    const unknown = await call(port, "chain_submitBlock", { block: {} })
    expect(unknown.status).toBe(400)
    expect(unknown.body.error.code).toBe(RPC_METHOD_NOT_FOUND)
    // This server is loopback-bound over a real Node, so the list it advertises
    // is the reads plus the one write.
    expect(unknown.body.error.data.methods).toEqual(rpcMethodNames(true))
    expect(unknown.body.id).toBe(1)
  })

  it("answers -32602 for parameters it cannot use", async () => {
    const missing = await call(port, "chain_getBalance", {})
    expect(missing.body.error.code).toBe(RPC_INVALID_PARAMS)

    const wrongType = await call(port, "chain_getBalance", { account: 7 })
    expect(wrongType.body.error.code).toBe(RPC_INVALID_PARAMS)

    const empty = await call(port, "chain_getBalance", [])
    expect(empty.body.error.code).toBe(RPC_INVALID_PARAMS)

    const tooMany = await call(port, "chain_getNonce", ["a", "b"])
    expect(tooMany.body.error.code).toBe(RPC_INVALID_PARAMS)

    const scalar = await http(port, { jsonrpc: "2.0", method: "chain_getBalance", params: 5, id: 1 })
    expect(scalar.body.error.code).toBe(RPC_INVALID_PARAMS)

    const unwanted = await call(port, "chain_height", { account: "x" })
    expect(unwanted.body.error.code).toBe(RPC_INVALID_PARAMS)
  })

  it("is POST only and caps the request body", async () => {
    const get = await http(port, "", "GET")
    expect(get.status).toBe(405)
    expect(get.body.error.code).toBe(RPC_INVALID_REQUEST)

    const put = await http(port, { jsonrpc: "2.0", method: "chain_height", id: 1 }, "PUT")
    expect(put.status).toBe(405)

    const huge = JSON.stringify({
      jsonrpc: "2.0",
      method: "chain_getBalance",
      params: { account: "x".repeat(MAX_RPC_BODY_BYTES + 1024) },
      id: 1,
    })
    expect(Buffer.byteLength(huge)).toBeGreaterThan(MAX_RPC_BODY_BYTES)
    const oversized = await http(port, huge)
    expect(oversized.status).toBe(413)
    expect(oversized.body.error.code).toBe(RPC_INVALID_REQUEST)

    // Just under the cap is still a normal, answered call.
    const big = await call(port, "chain_getBalance", {
      account: "x".repeat(MAX_RPC_BODY_BYTES - 512),
    })
    expect(big.status).toBe(200)
    expect(big.body.result.balance).toBe(0)
  }, 10000)

  it("acknowledges a notification with 204 and no body", async () => {
    const notification = await http(port, { jsonrpc: "2.0", method: "chain_height" })
    expect(notification.status).toBe(204)
    expect(notification.text).toBe("")
  })

  it("never moves the tip: no method on the surface can submit a block", async () => {
    const before = blockHash(node.tip)
    const balanceBefore = node.balances.balanceOf(accountHex(21))
    const nonceBefore = node.nonces.lastNonce(accountHex(21))

    for (const method of RPC_METHOD_NAMES) {
      // Every read method with and without an account argument; none writes.
      await call(port, method, { account: accountHex(21) })
      await call(port, method)
    }
    // The one write, offered an unsigned transaction: the pool refuses it, so
    // nothing is pooled and nothing on the chain moves either.
    const unsigned = await call(port, "chain_sendTransaction", [
      { sender: accountHex(21), recipient: "bob", amount: 1, nonce: 99 },
    ])
    expect(unsigned.status).toBe(200)
    expect(unsigned.body.result.admitted).toBe(false)
    expect(unsigned.body.result.reason).toBe("unauthorised")

    expect(blockHash(node.tip)).toBe(before)
    expect(node.balances.balanceOf(accountHex(21))).toBe(balanceBefore)
    expect(node.nonces.lastNonce(accountHex(21))).toBe(nonceBefore)
    // The names are the audit: the read table holds nothing that submits, sends
    // or mines, and the write table holds exactly one method — which reaches the
    // mempool and nothing else. There is still no way to submit a BLOCK.
    expect(RPC_METHOD_NAMES).toEqual([
      "chain_height",
      "chain_tip",
      "chain_getBalance",
      "chain_getNonce",
      "chain_mempool",
      "chain_validators",
    ])
    expect(RPC_WRITE_METHOD_NAMES).toEqual(["chain_sendTransaction"])
    expect(node.mempool.size).toBe(0)
  }, 10000)

  it("reports -32603 when a method itself fails", async () => {
    // A node whose tip cannot be hashed (a fractional height the canonical
    // header encoder refuses) is this node's fault, not the caller's.
    const brokenTip = { ...genesis, height: 0.5 } as Block
    const stub = {
      tip: brokenTip,
      validators: [],
      balances: { balanceOf: () => 0 },
      nonces: { lastNonce: () => undefined },
    }
    const handle = startRpcServer(stub, 0)
    const stubPort = await handle.ready()
    const answer = await call(stubPort, "chain_tip")
    expect(answer.status).toBe(500)
    expect(answer.body.error.code).toBe(RPC_INTERNAL_ERROR)
    // chain_height, which touches no encoder, still answers on the same server.
    const height = await call(stubPort, "chain_height")
    expect(height.body.result).toEqual({ height: 0.5 })
    await handle.close()
  })

  it("closes cleanly and stops answering", async () => {
    const handle = startRpcServer(node, 0)
    const tempPort = await handle.ready()
    const alive = await call(tempPort, "chain_height")
    expect(alive.status).toBe(200)
    await handle.close()
    await expect(call(tempPort, "chain_height")).rejects.toBeDefined()
  }, 10000)
})
