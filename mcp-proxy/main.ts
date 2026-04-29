const SUPABASE_MCP = "https://kxkynhbulfxkibwmwrwl.supabase.co/functions/v1/receipts-mcp";
const AUTH_SERVER = "https://kxkynhbulfxkibwmwrwl.supabase.co/auth/v1";
const MCP_URL = "https://mcp.receipts.tools";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-session-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

Deno.serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // What claude.ai checks first — must exist at domain root
  if (url.pathname === "/.well-known/oauth-protected-resource") {
    return Response.json({
      resource: MCP_URL,
      authorization_servers: [AUTH_SERVER],
      bearer_methods_supported: ["header"],
      scopes_supported: ["openid", "email"],
    }, { headers: corsHeaders });
  }

  // Forward Supabase OAuth discovery so claude.ai can find the auth endpoints
  if (
    url.pathname === "/.well-known/oauth-authorization-server" ||
    url.pathname === "/.well-known/openid-configuration"
  ) {
    const res = await fetch(`${AUTH_SERVER}${url.pathname}`);
    const data = await res.json();
    return Response.json(data, { headers: corsHeaders });
  }

  // Proxy all MCP traffic to the Supabase edge function
  const headers = new Headers(req.headers);
  headers.delete("host");

  const upstream = await fetch(SUPABASE_MCP, {
    method: req.method,
    headers,
    body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
  });

  const responseHeaders = new Headers(upstream.headers);
  for (const [k, v] of Object.entries(corsHeaders)) {
    responseHeaders.set(k, v);
  }
  // Rewrite WWW-Authenticate to point to mcp.receipts.tools
  if (responseHeaders.has("www-authenticate")) {
    responseHeaders.set("www-authenticate", `Bearer resource_metadata="${MCP_URL}"`);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
});
