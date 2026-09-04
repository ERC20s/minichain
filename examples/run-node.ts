import { Node } from "../src/node"
import { createBlock } from "../src/block"
import { Validator } from "../src/validators"
import { DEFAULT_RPC_HOST, DEFAULT_RPC_PORT, RPC_METHOD_NAMES, startRpcServer } from "../src/rpc/server"
import { MAX_MEMPOOL, MAX_MEMPOOL_PER_SENDER } from "../src/state/mempool"

function parsePeers(env?: string): string[] {
  if (!env) return []
  return env.split(",").map(s => s.trim()).filter(Boolean)
}

/**
 * VALIDATORS is "hexkey:stake,hexkey:stake" — the staked set this node
 * enforces. Left unset, the node keeps the permissive behaviour: any block with
 * a valid header signature extends the chain. Each key is the lower-case hex of
 * a raw 32-byte ed25519 public key; each stake a non-negative integer.
 */
function parseValidators(env?: string): Validator[] {
  if (!env) return []
  const out: Validator[] = []
  for (const entry of env.split(",").map(s => s.trim()).filter(Boolean)) {
    const at = entry.lastIndexOf(":")
    if (at <= 0) {
      console.warn(`ignoring VALIDATORS entry without a stake: ${entry}`)
      continue
    }
    const publicKey = entry.slice(0, at).trim().toLowerCase()
    const stake = Number(entry.slice(at + 1).trim())
    if (!/^[0-9a-f]+$/.test(publicKey) || publicKey.length % 2 !== 0) {
      console.warn(`ignoring VALIDATORS entry with a non-hex key: ${entry}`)
      continue
    }
    if (!Number.isFinite(stake) || !Number.isInteger(stake) || stake < 0) {
      console.warn(`ignoring VALIDATORS entry with a bad stake: ${entry}`)
      continue
    }
    out.push({ publicKey, stake })
  }
  return out
}

/**
 * A port setting that must be a usable TCP port; anything else falls back to
 * the default with a warning rather than handing NaN to listen().
 */
function parsePort(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback
  const value = parseInt(raw, 10)
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    console.warn(`ignoring ${name}=${raw}: not a port number, using ${fallback}`)
    return fallback
  }
  return value
}

const port = parsePort("PORT", process.env.PORT, 9300)
const peers = parsePeers(process.env.PEERS)
const validators = parseValidators(process.env.VALIDATORS)
/**
 * The read-only JSON-RPC surface (src/rpc/server.ts). It binds loopback, so it
 * is a way to ask a node what it knows, never a second way to put a block into
 * it. RPC_PORT=0 disables it.
 */
const rpcPort = parsePort("RPC_PORT", process.env.RPC_PORT, DEFAULT_RPC_PORT)

const genesis = createBlock("genesis", 0, [])
const node = new Node(port, peers, genesis, validators)

console.log(`minichain node started on port ${port}`)
if (peers.length) console.log(`peers: ${peers.join(", ")}`)
if (validators.length) {
  const total = validators.reduce((sum, v) => sum + v.stake, 0)
  console.log(`validators: ${validators.length} (total stake ${total}) — proposer selection enforced`)
} else {
  console.log("validators: none configured — any validly signed block is accepted")
}
console.log(
  `mempool: gossiped transactions are validated, pooled and relayed once ` +
    `(up to ${MAX_MEMPOOL} pending, ${MAX_MEMPOOL_PER_SENDER} per sender)`
)

/**
 * The JSON-RPC surface, started next to the node. Read-only and loopback-bound:
 * it exposes the tip, balances, nonces, the pending-transaction pool and the
 * staked set, and no method on it can submit a transaction or a block, so the
 * acceptance rules in src/node.ts stay the only way into this chain.
 */
const rpc = rpcPort > 0 ? startRpcServer(node, rpcPort, DEFAULT_RPC_HOST) : null
if (rpc) {
  rpc
    .ready()
    .then((bound) => {
      console.log(`json-rpc listening on http://${DEFAULT_RPC_HOST}:${bound} (POST, read-only)`)
      console.log(`json-rpc methods: ${RPC_METHOD_NAMES.join(", ")}`)
    })
    .catch((err: Error) => {
      console.warn(`json-rpc not started on port ${rpcPort}: ${err.message}`)
    })
} else {
  console.log("json-rpc: disabled (RPC_PORT=0)")
}

function shutdown() {
  console.log("shutting down")
  try { node.close() } catch (e) {}
  if (rpc) {
    // Stop listening before the process goes, so a restart can rebind the port.
    // The timer is a ceiling on how long shutdown may wait for that.
    setTimeout(() => process.exit(0), 500)
    rpc.close().then(() => process.exit(0), () => process.exit(0))
    return
  }
  process.exit(0)
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
