/** Normalize headers for the decoded body returned by Deno fetch. */
export function proxyResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers(upstream);
  // fetch decodes compressed bodies; the upstream encoding and byte count
  // no longer describe the stream. Let Deno frame/compress the new response.
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  return headers;
}
