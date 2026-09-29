import { proxyResponseHeaders } from "./response-headers.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

Deno.test("decoded upstream headers preserve MCP metadata without stale framing", () => {
  const upstream = new Headers({
    "content-encoding": "gzip", "content-length": "149", "transfer-encoding": "chunked",
    "content-type": "application/json", "www-authenticate": 'Bearer realm="receipts"',
    "mcp-session-id": "test-session", "access-control-allow-origin": "*",
  });
  const result = proxyResponseHeaders(upstream);
  for (const name of ["content-encoding", "content-length", "transfer-encoding"]) {
    assert(!result.has(name), `stale ${name}`);
    assert(upstream.has(name), `mutated original ${name}`);
  }
  for (const name of ["content-type", "www-authenticate", "mcp-session-id", "access-control-allow-origin"]) {
    assert(result.get(name) === upstream.get(name), `lost ${name}`);
  }
});

Deno.test("gzip upstream can be fetched through a streaming proxy", async () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "receipts" } } });
  const compressed = new Uint8Array(await new Response(
    new Blob([body]).stream().pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer());
  const upstream = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, () =>
    new Response(compressed, { headers: {
      "content-encoding": "gzip", "content-length": String(compressed.length),
      "content-type": "application/json",
    } }));
  const proxy = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async () => {
    const response = await fetch(`http://127.0.0.1:${upstream.addr.port}/`);
    return new Response(response.body, { status: response.status, headers: proxyResponseHeaders(response.headers) });
  });
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.addr.port}/`, { headers: { "accept-encoding": "identity" } });
    assert(response.status === 200, "proxy status changed");
    assert(!response.headers.has("content-encoding"), "decoded body still marked compressed");
    assert(await response.text() === body, "MCP response incomplete or changed");
  } finally {
    await proxy.shutdown();
    await upstream.shutdown();
  }
});
