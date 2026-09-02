import { startGossipNode } from "../src/gossip/ws"
import { keypairFromSeed, sign, verify } from "../src/crypto/ed25519"
import { canonicalEncoding } from "../src/coding/serialize"

function wait(ms: number) { return new Promise((res) => setTimeout(res, ms)) }

describe("gossip websocket transport", () => {
  it("delivers a signed transaction from node A to node B", async () => {
    const portA = 9101
    const portB = 9102
    const urlA = `ws://127.0.0.1:${portA}`
    const urlB = `ws://127.0.0.1:${portB}`

    const nodeA = startGossipNode(portA, [urlB])
    const nodeB = startGossipNode(portB, [urlA])

    const seed = new Uint8Array(32)
    seed[0] = 1
    const kp = keypairFromSeed(seed)

    const tx = { sender: "alice", recipient: "bob", amount: 7, nonce: 1 }
    const msg = canonicalEncoding(tx as any)
    const sig = sign(msg, kp.secretKey)

    let received = false
    nodeB.on("tx", (m) => {
      try {
        expect(m.payload).toEqual(msg)
        expect(m.sig).toBeDefined()
        expect(verify(m.payload, m.sig!, kp.publicKey)).toBe(true)
        received = true
      } catch (e) {
        // swallow assertion to let test continue and fail
      }
    })

    // give servers a moment to start and connect
    await wait(50)
    nodeA.broadcast("tx", msg, { sig, pubKey: kp.publicKey })

    // wait for delivery
    await wait(200)

    nodeA.close()
    nodeB.close()

    expect(received).toBe(true)
  }, 1000)

  it("delivers a block message between peers", async () => {
    const portA = 9201
    const portB = 9202
    const urlA = `ws://127.0.0.1:${portA}`
    const urlB = `ws://127.0.0.1:${portB}`

    const nodeA = startGossipNode(portA, [urlB])
    const nodeB = startGossipNode(portB, [urlA])

    const blk = { parentHash: "0x00", height: 1, timestamp: Date.now(), transactions: [], merkleRoot: "0x00" }
    const payload = new TextEncoder().encode(JSON.stringify(blk))

    let got = false
    nodeB.on("blk", (m) => {
      try {
        expect(new TextDecoder().decode(m.payload)).toEqual(JSON.stringify(blk))
        got = true
      } catch (e) {}
    })

    await wait(50)
    nodeA.broadcast("blk", payload)
    await wait(200)

    nodeA.close()
    nodeB.close()

    expect(got).toBe(true)
  }, 1000)

  it("ignores an oversized payloadHex without crashing", async () => {
    const portA = 9301
    const portB = 9302
    const urlA = `ws://127.0.0.1:${portA}`
    const urlB = `ws://127.0.0.1:${portB}`

    const nodeA = startGossipNode(portA, [urlB])
    const nodeB = startGossipNode(portB, [urlA])

    let received = false
    nodeB.on("tx", (m) => {
      received = true
    })

    await wait(50)

    // craft an oversized payloadHex (one more than MAX_PAYLOAD_HEX)
    const oversized = "f".repeat(131073)
    const env = JSON.stringify({ type: "tx", payloadHex: oversized })

    // send directly to server socket set (connect and send)
    const ws = new (require("ws"))(urlA)
    await new Promise((res) => ws.on("open", res))
    ws.send(env)

    await wait(200)

    ws.close()
    nodeA.close()
    nodeB.close()

    expect(received).toBe(false)
  }, 1000)
})
