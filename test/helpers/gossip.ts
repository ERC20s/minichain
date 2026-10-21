/**
 * Shared helpers for tests that open real gossip links.
 *
 * A fixed sleep is a guess about how fast this machine is, and a slow CI runner
 * makes it wrong: a dial made before its peer listens only comes up on a
 * re-dial, after PEER_RECONNECT_MIN_MS or more. These helpers wait for the
 * condition itself, with a bounded deadline, and say exactly what was missing
 * when the deadline passes. closeAll() waits until every server and socket has
 * actually closed, so nothing is still running when a test file ends.
 */

export interface PeerCounts {
  inbound: number
  outbound: number
  total: number
}

/** Anything that reports its live gossip links: a Node or a GossipNode. */
export interface HasPeers {
  peerCounts(): PeerCounts
}

/** Anything with a close(); a returned promise is awaited. */
export interface Closable {
  close(): unknown
}

export const DEFAULT_WAIT_MS = 5000
const POLL_MS = 25

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Resolve once `predicate()` holds; throw `Timed out after Nms waiting for
 * <description>` if it does not hold within `timeoutMs`.
 */
export async function waitUntil(
  predicate: () => boolean,
  description: string,
  timeoutMs: number = DEFAULT_WAIT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`)
    }
    await sleep(POLL_MS)
  }
}

/**
 * Resolve once `node` reports at least `want.inbound` inbound and
 * `want.outbound` outbound open links (either may be omitted, meaning 0).
 * Throws with the counts it last saw if they are not reached in `timeoutMs`.
 */
export async function waitForPeers(
  node: HasPeers,
  want: { inbound?: number; outbound?: number },
  timeoutMs: number = DEFAULT_WAIT_MS,
  label: string = "node"
): Promise<void> {
  const inbound = want.inbound ?? 0
  const outbound = want.outbound ?? 0
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const c = node.peerCounts()
    if (c.inbound >= inbound && c.outbound >= outbound) return
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for ${label} to have ` +
          `inbound >= ${inbound} and outbound >= ${outbound}; ` +
          `it has inbound ${c.inbound}, outbound ${c.outbound}`
      )
    }
    await sleep(POLL_MS)
  }
}

/**
 * Close every node (undefined entries are skipped) and wait for each close to
 * finish, so no socket, server or re-dial outlives the test.
 */
export async function closeAll(...nodes: Array<Closable | undefined | null>): Promise<void> {
  await Promise.all(
    nodes.map(async (n) => {
      if (!n) return
      await n.close()
    })
  )
}
