import { request } from "http"
import { blockHash, createGenesisBlock } from "../src/block"
import { Node } from "../src/node"
import {
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
  RPC_WRITE_METHOD_NAMES,
  RpcServerHandle,
  isLoopbackHost,
  rpcMethodNames,
  startRpcServer,
} from "../src/rpc/server"
import { transactionId } from "../src/state/mempool"
import { Validator, publicKeyToHex } from "../src/validators"
import { account, accountHex, funded, signedTx } from "./helpers/signed-tx"

/**
 * chain_sendTransaction: the way IN from outside the process (src/rpc/server.ts).
 *
 * Before this, a running node could be asked anything and told nothing. The RPC
 * was read-only by construction and the only filler of a mempool was a gossiped
 * "tx" frame from another node, so an operator with `npm run dev` had no way to
 * put a transfer on the chain at all and the proposer loop had nothing to mint.
 *
 * What is pinned here:
 *  - a funded sender's signed transaction is admitted, gets the pool's id, and
 *    shows up in chain_mempool;
 *  - a forged signature is refused with the pool's own reason and pools nothing
 *    — a refusal is a RESULT (HTTP 200), not a JSON-RPC error;
 *  - a resubmission is a duplicate, and malformed params are -32602;
 *  - a non-loopback bind does not serve the method at all (-32601,
 *    data.reason "not-loopback") while its reads keep working;
 *  - a node with no submitTransaction answers -32601, data.reason "unsupported";
 *  - and the loop closes: the elected proposer mints the submitted transaction
 *    into block 1, chain_height moves off 0 and the pool drains.
 *
 * The gossip port used below (9741) is used by no other test file; the RPC
 * servers bind port 0, so the OS picks their ports.
 */
function wait(ms: number) {
  return new Promise((res) => setTimeout(res, ms))
}

type RpcAnswer = { status: number; body: any; text: string }

function http(port: number, body: string | object, host = "127.0.0.1"): Promise<RpcAnswer> {
  const payload = typeof body === "string" ? body : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = request(
      { host, port, method: "POST", path: "/", headers: { "Content-Type": "application/json" } },
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

function call(port: number, method: string, params?: unknown, id: any = 1): Promise<RpcAnswer> {
  const body: Record<string, unknown> = { jsonrpc: "2.0", method, id }
  if (params !== undefined) body.params = params
  return http(port, body)
}

describe("chain_sendTransaction: the loopback write path", () => {
  // One staked validator, so it is elected for every seed and the block below is
  // judged on everything except the election.
  const proposer = account(41)
  const validators: Validator[] = [{ publicKey: publicKeyToHex(proposer.publicKey), stake: 100 }]
  // The sender is funded the way examples/run-node.ts funds one: opening
  // balances handed to the Node, not a genesis transaction.
  const sender = accountHex(42)
  const opening = funded([42], 1000)
  const genesis = createGenesisBlock()

  let node: Node
  let rpc: RpcServerHandle
  let port = 0

  const first = signedTx(42, { recipient: "bob", amount: 25, nonce: 1 })

  beforeAll(async () => {
    node = new Node(9741, [], genesis, validators, opening)
    rpc = startRpcServer(node, 0)
    port = await rpc.ready()
    await wait(60)
  }, 10000)

  afterAll(async () => {
    await rpc.close()
    try { node.close() } catch (e) {}
    await wait(50)
  })

  it("serves the write method on a loopback bind and advertises it", () => {
    expect(rpc.writesEnabled).toBe(true)
    expect(RPC_WRITE_METHOD_NAMES).toEqual(["chain_sendTransaction"])
    expect(rpcMethodNames(true)).toContain("chain_sendTransaction")
    expect(rpcMethodNames(false)).not.toContain("chain_sendTransaction")

    // The bind rule itself: 127.0.0.0/8, ::1 and localhost are loopback and
    // nothing else is.
    expect(isLoopbackHost("127.0.0.1")).toBe(true)
    expect(isLoopbackHost("127.0.0.53")).toBe(true)
    expect(isLoopbackHost("localhost")).toBe(true)
    expect(isLoopbackHost("::1")).toBe(true)
    expect(isLoopbackHost("[::1]")).toBe(true)
    expect(isLoopbackHost("0.0.0.0")).toBe(false)
    expect(isLoopbackHost("::")).toBe(false)
    expect(isLoopbackHost("10.0.0.4")).toBe(false)
    expect(isLoopbackHost("chain.example.com")).toBe(false)
  })

  it("admits a funded sender's signed transaction and lists it in chain_mempool", async () => {
    const answer = await call(port, "chain_sendTransaction", { transaction: first })
    expect(answer.status).toBe(200)
    expect(answer.body.result).toEqual({
      admitted: true,
      id: transactionId(first),
      reason: "admitted",
    })

    expect(node.mempool.size).toBe(1)
    const pool = await call(port, "chain_mempool")
    expect(pool.body.result.size).toBe(1)
    expect(pool.body.result.pending).toEqual([transactionId(first)])

    // Nothing on the chain moved: the pool is not consensus.
    const height = await call(port, "chain_height")
    expect(height.body.result).toEqual({ height: 0 })
    expect(node.balances.balanceOf(sender)).toBe(1000)
    expect(node.nonces.lastNonce(sender)).toBeUndefined()
  })

  it("refuses a forged signature with the pool's reason and pools nothing", async () => {
    const forged = { ...signedTx(42, { recipient: "bob", amount: 5, nonce: 2 }), signature: "aa".repeat(64) }
    const answer = await call(port, "chain_sendTransaction", [forged])
    // A refusal is an ANSWER, not a JSON-RPC error: the call was well formed.
    expect(answer.status).toBe(200)
    expect(answer.body.error).toBeUndefined()
    expect(answer.body.result.admitted).toBe(false)
    expect(answer.body.result.reason).toBe("unauthorised")
    expect(node.mempool.size).toBe(1)

    // Unaffordable is refused the same way: 1000 opening, 25 already pending.
    const tooBig = signedTx(42, { recipient: "bob", amount: 5000, nonce: 3 })
    const poor = await call(port, "chain_sendTransaction", { tx: tooBig })
    expect(poor.body.result.admitted).toBe(false)
    expect(poor.body.result.reason).toBe("unaffordable")
    expect(node.mempool.size).toBe(1)
  })

  it("answers duplicate for a resubmission and -32602 for params it cannot use", async () => {
    const again = await call(port, "chain_sendTransaction", { transaction: first })
    expect(again.body.result).toEqual({
      admitted: false,
      id: transactionId(first),
      reason: "duplicate",
    })
    expect(node.mempool.size).toBe(1)

    for (const params of [undefined, {}, [], [first, first], "tx", 7, [null], { transaction: 5 }]) {
      const bad = await call(port, "chain_sendTransaction", params as unknown)
      expect(bad.status).toBe(400)
      expect(bad.body.error.code).toBe(RPC_INVALID_PARAMS)
    }
    expect(node.mempool.size).toBe(1)
  }, 10000)

  it("closes the loop: the elected proposer mints the submitted transaction into block 1", async () => {
    const minted = node.proposeBlock(proposer.secretKey, proposer.publicKey)
    expect(minted).not.toBeNull()
    expect(minted!.height).toBe(1)
    expect(minted!.transactions.length).toBe(1)
    expect(minted!.transactions[0].signature).toBe(first.signature)

    const height = await call(port, "chain_height")
    expect(height.body.result).toEqual({ height: 1 })

    const tip = await call(port, "chain_tip")
    expect(tip.body.result.hash).toBe(blockHash(minted!))
    expect(tip.body.result.transactionCount).toBe(1)

    const balance = await call(port, "chain_getBalance", { account: sender })
    expect(balance.body.result.balance).toBe(975)
    const recipient = await call(port, "chain_getBalance", { account: "bob" })
    expect(recipient.body.result.balance).toBe(25)
    const nonce = await call(port, "chain_getNonce", { account: sender })
    expect(nonce.body.result.nonce).toBe(1)

    // and the pool drained with the block
    const pool = await call(port, "chain_mempool")
    expect(pool.body.result.size).toBe(0)
    expect(node.mempool.size).toBe(0)
  }, 10000)

  it("executes a notification submit and answers 204 with no body", async () => {
    const second = signedTx(42, { recipient: "bob", amount: 5, nonce: 2 })
    const answer = await http(port, { jsonrpc: "2.0", method: "chain_sendTransaction", params: [second] })
    expect(answer.status).toBe(204)
    expect(answer.text).toBe("")
    // A write is run for its effect even when no answer was asked for.
    expect(node.mempool.size).toBe(1)
    expect(node.mempool.ids()).toEqual([transactionId(second)])
    node.mempool.clear()
  })

  it("does not serve the method on a non-loopback bind, but still reads", async () => {
    const wide = startRpcServer(node, 0, "0.0.0.0")
    const widePort = await wide.ready()
    try {
      expect(wide.writesEnabled).toBe(false)

      const refused = await call(widePort, "chain_sendTransaction", { transaction: first })
      expect(refused.status).toBe(400)
      expect(refused.body.error.code).toBe(RPC_METHOD_NOT_FOUND)
      expect(refused.body.error.data.reason).toBe("not-loopback")
      expect(refused.body.error.data.methods).not.toContain("chain_sendTransaction")
      expect(node.mempool.size).toBe(0)

      // The reads are untouched by the rule.
      const height = await call(widePort, "chain_height")
      expect(height.status).toBe(200)
      expect(height.body.result).toEqual({ height: 1 })
    } finally {
      await wide.close()
    }
  }, 10000)

  it("answers -32601 unsupported for a node that cannot accept transactions", async () => {
    const stub = {
      tip: node.tip,
      validators: [],
      balances: { balanceOf: () => 0 },
      nonces: { lastNonce: () => undefined },
    }
    const handle = startRpcServer(stub, 0)
    const stubPort = await handle.ready()
    try {
      expect(handle.writesEnabled).toBe(false)
      const answer = await call(stubPort, "chain_sendTransaction", { transaction: first })
      expect(answer.status).toBe(400)
      expect(answer.body.error.code).toBe(RPC_METHOD_NOT_FOUND)
      expect(answer.body.error.data.reason).toBe("unsupported")
    } finally {
      await handle.close()
    }
  }, 10000)
})
