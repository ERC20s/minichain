import http from 'http';
import url from 'url';
import WebSocket, { Server as WSServer } from 'ws';
import { JsonRpcHandler, JsonRpcRequest, ChainInterface, TxPoolInterface } from './jsonrpc';

export type ServerHandles = {
  httpServer: http.Server;
  wsServer: WSServer;
};

export function createServer(chain: ChainInterface, txpool: TxPoolInterface, port = 8080): ServerHandles {
  const handler = new JsonRpcHandler(chain, txpool);

  const httpServer = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url || '', true);
    if (req.method === 'POST' && parsed.pathname === '/rpc') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', async () => {
        try {
          const json = JSON.parse(body) as JsonRpcRequest;
          const resp = await handler.handle(json);
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(200);
          res.end(JSON.stringify(resp));
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  const wsServer = new WSServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    const pathname = url.parse(request.url || '').pathname;
    if (pathname === '/ws') {
      wsServer.handleUpgrade(request, socket as any, head, (ws) => {
        ws.on('message', (data) => {
          // very small JSON-RPC over WS consumer: accept subscribeNewBlock
          try {
            const msg = JSON.parse(String(data)) as JsonRpcRequest;
            if (msg.method === 'subscribeNewBlock') {
              const id = msg.id ?? null;
              ws.send(JSON.stringify({ jsonrpc: '2.0', id, result: { subscriptionId: 'sub-1' } }));
            } else {
              ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32601, message: 'Method not found' } }));
            }
          } catch (e) {
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
          }
        });
      });
    } else {
      socket.destroy();
    }
  });

  return { httpServer, wsServer };
}
