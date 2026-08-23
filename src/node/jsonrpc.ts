import { IncomingMessage, ServerResponse } from 'http';
import { Transaction, Block } from '../types';

// Minimal interfaces the RPC layer depends on. Real implementations will be
// provided by the node when wiring the RPC server in production code.
export interface ChainInterface {
  getHeight(): Promise<number>;
  getBlockByHash(hash: string): Promise<Block | null>;
  getBlockByHeight(height: number): Promise<Block | null>;
}

export interface TxPoolInterface {
  submit(tx: Transaction): Promise<string>; // returns txHash
}

export type JsonRpcRequest = {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: any;
};

export type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
};

export class JsonRpcHandler {
  constructor(private chain: ChainInterface, private txpool: TxPoolInterface) {}

  async handle(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const id = req.id ?? null;
    try {
      switch (req.method) {
        case 'getChainHeight': {
          const height = await this.chain.getHeight();
          return { jsonrpc: '2.0', id, result: { height } };
        }
        case 'getBlockByHash': {
          const { hash } = req.params || {};
          if (!hash) throw { code: -32602, message: 'Missing hash param' };
          const block = await this.chain.getBlockByHash(hash);
          return { jsonrpc: '2.0', id, result: { block } };
        }
        case 'getBlockByHeight': {
          const { height } = req.params || {};
          if (typeof height !== 'number') throw { code: -32602, message: 'Missing or invalid height param' };
          const block = await this.chain.getBlockByHeight(height);
          return { jsonrpc: '2.0', id, result: { block } };
        }
        case 'submitTransaction': {
          const { tx } = req.params || {};
          if (!tx) throw { code: -32602, message: 'Missing tx param' };
          const txHash = await this.txpool.submit(tx as Transaction);
          return { jsonrpc: '2.0', id, result: { txHash } };
        }
        default:
          throw { code: -32601, message: 'Method not found' };
      }
    } catch (e: any) {
      if (e && typeof e.code === 'number' && typeof e.message === 'string') {
        return { jsonrpc: '2.0', id, error: { code: e.code, message: e.message, data: e.data } };
      }
      return { jsonrpc: '2.0', id, error: { code: -32000, message: String(e) } };
    }
  }
}
