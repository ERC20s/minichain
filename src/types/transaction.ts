export interface Transaction {
  sender: string
  recipient: string
  amount: number
  nonce: number
  payload?: unknown
}
