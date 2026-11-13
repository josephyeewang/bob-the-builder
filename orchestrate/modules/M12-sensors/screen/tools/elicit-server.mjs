// A stand-in MCP server for R-0b-150's "MCP input request" capture: one tool, ask_name, which asks the user for a
// name through elicitation/create and returns whatever comes back. stdio, one JSON-RPC message per line. Test use only:
// the capture tool starts it through --mcp-config in a throwaway session; nothing else loads it.

import { createInterface } from 'node:readline';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const ELICIT_MESSAGE = 'Fixture asks: what name should it use?';

export function serve(input = process.stdin, output = process.stdout) {
  const send = (m) => output.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  const waiting = new Map(); // our request id -> the tools/call id it answers
  let next = 1;
  createInterface({ input }).on('line', (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.method === 'initialize') {
      send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } } });
    } else if (m.method === 'tools/list') {
      send({ id: m.id, result: { tools: [{ name: 'ask_name', description: 'Asks the user for a name.', inputSchema: { type: 'object', properties: {} } }] } });
    } else if (m.method === 'tools/call') {
      const id = `ask-${next++}`;
      waiting.set(id, m.id);
      send({ id, method: 'elicitation/create', params: { message: ELICIT_MESSAGE, requestedSchema: { type: 'object', properties: { name: { type: 'string', title: 'Name' } }, required: ['name'] } } });
    } else if (m.id !== undefined && waiting.has(m.id)) {
      const callId = waiting.get(m.id);
      waiting.delete(m.id);
      send({ id: callId, result: { content: [{ type: 'text', text: JSON.stringify(m.result ?? m.error ?? null) }] } });
    } else if (m.id !== undefined && m.method) {
      send({ id: m.id, result: {} }); // ping and anything else asked of us
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) serve();
