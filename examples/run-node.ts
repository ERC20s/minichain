import { Node } from "../src/node"
import { createBlock } from "../src/block"
import { Validator } from "../src/validators"

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

const port = Number(process.env.PORT ? parseInt(process.env.PORT, 10) : 9300)
const peers = parsePeers(process.env.PEERS)
const validators = parseValidators(process.env.VALIDATORS)

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

function shutdown() {
  console.log("shutting down")
  try { node.close() } catch (e) {}
  process.exit(0)
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
