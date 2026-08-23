import assert from 'assert';
import http from 'http';
import WebSocket from 'ws';
import { createServer } from '../src/node/server';
import { ChainInterface, TxPoolInterface } from '../src/node/jsonrpc';
import { Transaction } from '../src/types';

function startServer(chain: ChainInterface, txpool: TxPoolInterface): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const { httpServer } = createServer(chain, txpool, 0);
    const server = httpServer.listen(0, () => {
      const addr = server.address() as any;
      const port = addr.port;
      resolve({ port, close: () => new Promise((r) => server.close(() => r(null))) });
    });
  });
}

class MockChain implements ChainInterface {
  async getHeight() { return 7; }
  async getBlockByHash(_h: string) { return null; }
  async getBlockByHeight(_n: number) { return null; }
}

class MockTxPool implements TxPoolInterface {
  lastTx: Transaction | null = null;
  async submit(tx: Transaction) { this.lastTx = tx; return '0xdead'; }
}

(async function runTests() {
  // Simple assertions instead of a test runner so npm test can be minimal.
  const chain = new MockChain();
  const txpool = new MockTxPool();
  const srv = await startServer(chain, txpool);

  // test getChainHeight
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getChainHeight', params: null });
  const resp = await new Promise<any>((resolve) => {
    const req = http.request({ hostname: '127.0.0.1', port: srv.port, path: '/rpc', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.write(body); req.end();
  });
  assert.equal(resp.result.height, 7);

  // test submitTransaction
  const tx = { from: 'a', to: 'b', amount: 1 };
  const body2 = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'submitTransaction', params: { tx } });
  const resp2 = await new Promise<any>((resolve) => {
    const req = http.request({ hostname: '127.0.0.1', port: srv.port, path: '/rpc', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.write(body2); req.end();
  });
  assert.equal(resp2.result.txHash, '0xdead');
  assert.deepEqual(txpool.lastTx, tx);

  // test websocket subscribe
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
  const wsResp = await new Promise<any>((resolve, reject) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'subscribeNewBlock', params: null }));
    });
    ws.on('message', (data) => resolve(JSON.parse(String(data))));
    ws.on('error', reject);
  });
  assert.equal(wsResp.result.subscriptionId, 'sub-1');
  ws.close();

  await srv.close();
  console.log('ALL_OK');
})();
