const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MCP_URL = "https://kxkynhbulfxkibwmwrwl.supabase.co/functions/v1/receipts-mcp";
const AUTH_SERVER = "https://kxkynhbulfxkibwmwrwl.supabase.co/auth/v1";
const WWW_AUTH = `Bearer resource_metadata="${MCP_URL}"`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, mcp-session-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

async function resolveUser(token: string): Promise<string | null> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: SERVICE_ROLE_KEY,
    },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.id ?? null;
}

async function db(path: string, method: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DB ${method} ${path} → ${res.status}: ${text}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function ok(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result }, { headers: corsHeaders });
}

function rpcError(id: unknown, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { headers: corsHeaders });
}

const TOOLS = [
  {
    name: "log_entry",
    description: "Log a new entry to Receipts. Pass the raw text and an optional project UUID to assign it immediately.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text or transcript to log" },
        project_id: { type: "string", description: "UUID of the project to assign this entry to" },
      },
      required: ["text"],
    },
  },
  {
    name: "get_my_builds",
    description: "Returns all projects owned by you with their status and entry count.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "update_build_status",
    description: "Update the status of one of your projects. Common values: active, Shipped, archived.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "UUID of the project to update" },
        status: { type: "string", description: "New status — e.g. active, Shipped, archived" },
      },
      required: ["project_id", "status"],
    },
  },
  {
    name: "add_idea",
    description: "Save a new idea to the Receipts ideas table.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The idea to capture" },
      },
      required: ["text"],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>, userId: string): Promise<string> {
  switch (name) {
    case "log_entry": {
      const row: Record<string, unknown> = {
        raw_transcript: args.text as string,
        claim: args.text as string,
        owner_id: userId,
        recorded_at: new Date().toISOString(),
        entry_type: "build",
        source: "mcp",
      };
      if (args.project_id) row.project_id = args.project_id;
      const result = await db("entries", "POST", row) as Array<{ id: string }>;
      const entry = Array.isArray(result) ? result[0] : result as { id?: string };
      return `Entry logged. ID: ${entry?.id ?? "unknown"}`;
    }

    case "get_my_builds": {
      const projects = await db(
        `projects?owner_id=eq.${userId}&select=id,name,status,created_at,entries(count)`,
        "GET"
      ) as Array<{ id: string; name: string; status: string | null; entries: Array<{ count: number }> }>;
      if (!projects.length) return "No builds found.";
      return projects
        .map((p) => `• ${p.name} [${p.status ?? "active"}] — ${p.entries?.[0]?.count ?? 0} entries  (id: ${p.id})`)
        .join("\n");
    }

    case "update_build_status": {
      await db(
        `projects?id=eq.${args.project_id as string}&owner_id=eq.${userId}`,
        "PATCH",
        { status: args.status }
      );
      return `Project ${args.project_id} updated to "${args.status}".`;
    }

    case "add_idea": {
      const result = await db("ideas", "POST", {
        raw_text: args.text as string,
        owner_id: userId,
        created_at: new Date().toISOString(),
      }) as Array<{ id: string }>;
      const idea = Array.isArray(result) ? result[0] : result as { id?: string };
      return `Idea saved. ID: ${idea?.id ?? "unknown"}`;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Protected Resource Metadata — claude.ai fetches this to discover the auth server
  if (req.method === "GET") {
    return Response.json({
      resource: MCP_URL,
      authorization_servers: [AUTH_SERVER],
      bearer_methods_supported: ["header"],
      scopes_supported: ["openid", "email"],
    }, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let rpc: { jsonrpc: string; id?: unknown; method: string; params?: unknown };
  try {
    rpc = await req.json();
  } catch {
    return rpcError(null, -32700, "Parse error");
  }

  const { id = null, method, params } = rpc;

  // initialize and its ack notification don't require auth — client hasn't sent token yet
  if (method === "initialize") {
    const clientVersion = (params as { protocolVersion?: string })?.protocolVersion ?? "2024-11-05";
    return ok(id, {
      protocolVersion: clientVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "receipts", version: "1.0.0" },
    });
  }

  if (method === "notifications/initialized") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // All other methods require a valid user JWT
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!token) {
    return new Response(
      JSON.stringify({ error: "Missing Authorization header" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json", "WWW-Authenticate": WWW_AUTH } }
    );
  }

  const userId = await resolveUser(token);
  if (!userId) {
    return new Response(
      JSON.stringify({ error: "Invalid or expired token" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json", "WWW-Authenticate": WWW_AUTH } }
    );
  }

  if (method === "tools/list") {
    return ok(id, { tools: TOOLS });
  }

  if (method === "tools/call") {
    const { name, arguments: args = {} } = params as { name: string; arguments?: Record<string, unknown> };
    try {
      const text = await callTool(name, args, userId);
      return ok(id, { content: [{ type: "text", text }] });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return rpcError(id, message.startsWith("Unknown tool:") ? -32601 : -32603, message);
    }
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
});
