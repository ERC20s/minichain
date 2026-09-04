import { Keypair, keypairFromSeed } from "../../src/crypto/ed25519"
import { bytesToHex, signTransaction, UnsignedTransaction } from "../../src/tx"
import { SignedTransaction } from "../../src/types/transaction"

/**
 * Fixtures for the signed-transaction rules.
 *
 * Every transaction in a block must carry an ed25519 signature that verifies
 * against the key its `sender` names, so test blocks can no longer be built from
 * {sender: "alice", ...} literals. These helpers keep that one line long: a
 * deterministic keypair per seed byte, and a transaction signed by it.
 *
 * Not a *.test.ts file, so jest's testMatch leaves it alone.
 */
export function account(seedByte: number): Keypair {
  const seed = new Uint8Array(32)
  seed[0] = seedByte
  return keypairFromSeed(seed)
}

/** The `sender` value for a seed byte: lowercase hex of the public key. */
export function accountHex(seedByte: number): string {
  return bytesToHex(account(seedByte).publicKey)
}

/**
 * Opening balances for a Node: every listed seed byte's account credited the
 * same amount.
 *
 * A node now refuses a transfer its sender cannot afford (src/state/balances.ts),
 * and these fixtures spend from accounts that never appear in genesis, so any
 * test that expects a transfer to LAND has to fund its senders — otherwise the
 * block is dropped for insolvency and the assertion under test never runs.
 *
 * Pass it as the fifth Node argument: new Node(port, peers, genesis, [], funded([11])).
 */
export function funded(seedBytes: number[], amount = 1000000): Record<string, number> {
  const out: Record<string, number> = {}
  for (const seedByte of seedBytes) out[accountHex(seedByte)] = amount
  return out
}

/** A transaction signed by the seed byte's account; `sender` comes from the key. */
export function signedTx(
  seedByte: number,
  tx: Omit<UnsignedTransaction, "sender">
): SignedTransaction {
  return signTransaction(tx, account(seedByte).secretKey)
}
