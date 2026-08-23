SPEC: minichain JSON-RPC API

This document describes the minimal JSON-RPC 2.0 surface implemented by the node in this cycle.

RPC entrypoint: POST /rpc
Content-Type: application/json

Request envelope (JSON-RPC 2.0):
{ "jsonrpc": "2.0", "id": <number|string|null>, "method": "<method>", "params": <object|array|null> }

Methods:
- getChainHeight
  - params: none
  - result: { "height": number }
  - error: standard JSON-RPC error if chain is unavailable

- getBlockByHash
  - params: { "hash": string }
  - result: { "block": Block | null }

- getBlockByHeight
  - params: { "height": number }
  - result: { "block": Block | null }

- submitTransaction
  - params: { "tx": Transaction }
  - result: { "txHash": string }
  - error: invalid params / rejected transaction

Subscriptions (WebSocket):
- WS endpoint: ws://<host>:<port>/ws
- Clients connect and receive JSON messages when new blocks are produced.
- Subscription method (JSON-RPC over WS): subscribeNewBlock -> returns { subscriptionId }
- Notification format (server -> client): { "method": "newBlock", "params": { "block": Block } }

Notes and assumptions:
- Block and Transaction types are referenced but minimal stubs are provided in src/types.ts to allow early integration; they will be replaced by richer implementations from earlier proposals as those land.
- Errors follow JSON-RPC 2.0: { code, message, data? }.
- The HTTP POST /rpc handler processes a single JSON-RPC request per HTTP POST. Batch requests are not required in this minimal surface.

Examples (HTTP):
POST /rpc
{ "jsonrpc": "2.0", "id": 1, "method": "getChainHeight", "params": null }

Response:
{ "jsonrpc": "2.0", "id": 1, "result": { "height": 42 } }
