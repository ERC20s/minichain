import { Node } from "../src/node"
import { createBlock } from "../src/block"

function parsePeers(env?: string): string[] {
  if (!env) return []
  return env.split(",").map(s => s.trim()).filter(Boolean)
}

const port = Number(process.env.PORT ? parseInt(process.env.PORT, 10) : 9300)
const peers = parsePeers(process.env.PEERS)

const genesis = createBlock("genesis", 0, [])
const node = new Node(port, peers, genesis)

console.log(`minichain node started on port ${port}`)
if (peers.length) console.log(`peers: ${peers.join(", ")}`)

function shutdown() {
  console.log("shutting down")
  try { node.close() } catch (e) {}
  process.exit(0)
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
