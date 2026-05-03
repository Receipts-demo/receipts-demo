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
    annotations: { destructiveHint: true },
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
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "update_build_status",
    description: "Update the status of one of your projects. Common values: active, Shipped, archived.",
    annotations: { destructiveHint: true },
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
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The idea to capture" },
      },
      required: ["text"],
    },
  },
  {
    name: "create_build",
    description: "Create a new build (project) in Receipts. You own it automatically.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name of the build" },
        goal: { type: "string", description: "What you're trying to achieve" },
        status: { type: "string", description: "Initial status — defaults to 'In Progress'" },
      },
      required: ["name", "goal"],
    },
  },
  {
    name: "get_entries",
    description: "Fetch all entries for one of your builds, ordered by date.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "UUID of the project" },
      },
      required: ["project_id"],
    },
  },
  {
    name: "get_shipped_card",
    description: "Get the shipped card for any project — key wins, one-line learning, tools used. Only works if the project status is Shipped.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "UUID of the project" },
      },
      required: ["project_id"],
    },
  },
  {
    name: "search_builds",
    description: "Search your builds by name or tools used.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term — matched against project name and tools used" },
      },
      required: ["query"],
    },
  },
  {
    name: "copy_build",
    description: "Copy any shipped build as a ready-to-use markdown document with a Claude prompt at the bottom. Works for your own builds and teammates' shipped builds.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "UUID of the project to copy" },
      },
      required: ["project_id"],
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

    case "create_build": {
      const result = await db("projects", "POST", {
        name: args.name as string,
        goal: args.goal as string,
        status: (args.status as string) ?? "In Progress",
        owner_id: userId,
        created_at: new Date().toISOString(),
      }) as Array<{ id: string }>;
      const project = Array.isArray(result) ? result[0] : result as { id?: string };
      return `Build created. ID: ${project?.id ?? "unknown"}`;
    }

    case "get_entries": {
      const entries = await db(
        `entries?project_id=eq.${args.project_id as string}&owner_id=eq.${userId}&select=id,claim,entry_type,created_at,raw_transcript&order=created_at.asc`,
        "GET"
      ) as Array<{ id: string; claim: string; entry_type: string | null; created_at: string; raw_transcript: string }>;
      if (!entries.length) return "No entries found for this project.";
      return entries
        .map((e) => `[${e.entry_type ?? "log"}] ${e.created_at.slice(0, 10)}: ${e.claim ?? e.raw_transcript}`)
        .join("\n");
    }

    case "get_shipped_card": {
      const projects = await db(
        `projects?id=eq.${args.project_id as string}&status=eq.Shipped&select=id,name,goal,key_wins,one_line_learning,tools_used`,
        "GET"
      ) as Array<{ id: string; name: string; goal: string; key_wins: string[] | null; one_line_learning: string | null; tools_used: string[] | null }>;
      if (!projects.length) return "Project not found or not yet shipped.";
      const p = projects[0];
      const wins = (p.key_wins ?? []).map((w) => `  • ${w}`).join("\n");
      const tools = (p.tools_used ?? []).join(", ") || "—";
      return `# ${p.name}\nGoal: ${p.goal}\nTools: ${tools}\n\nKey wins:\n${wins}\n\nOne-line learning: ${p.one_line_learning ?? "—"}`;
    }

    case "search_builds": {
      const projects = await db(
        `projects?owner_id=eq.${userId}&select=id,name,status,tools_used,entries(count)`,
        "GET"
      ) as Array<{ id: string; name: string; status: string | null; tools_used: string[] | null; entries: Array<{ count: number }> }>;
      const q = (args.query as string).toLowerCase();
      const matches = projects.filter((p) =>
        p.name.toLowerCase().includes(q) ||
        (p.tools_used ?? []).some((t) => t.toLowerCase().includes(q))
      );
      if (!matches.length) return `No builds found matching "${args.query as string}".`;
      return matches
        .map((p) => `• ${p.name} [${p.status ?? "active"}] — ${p.entries?.[0]?.count ?? 0} entries  (id: ${p.id})`)
        .join("\n");
    }

    case "copy_build": {
      const [projects, entries] = await Promise.all([
        db(
          `projects?id=eq.${args.project_id as string}&select=id,name,goal,key_wins,one_line_learning,tools_used`,
          "GET"
        ) as Promise<Array<{ id: string; name: string; goal: string; key_wins: string[] | null; one_line_learning: string | null; tools_used: string[] | null }>>,
        db(
          `entries?project_id=eq.${args.project_id as string}&select=claim,entry_type,created_at&order=created_at.asc`,
          "GET"
        ) as Promise<Array<{ claim: string; entry_type: string | null; created_at: string }>>,
      ]);
      if (!(projects as Array<unknown>).length) return "Build not found.";
      const p = (projects as Array<{ id: string; name: string; goal: string; key_wins: string[] | null; one_line_learning: string | null; tools_used: string[] | null }>)[0];
      const entryLines = (entries as Array<{ claim: string; entry_type: string | null; created_at: string }>)
        .map((e) => `- [${e.entry_type ?? "log"}] ${e.claim}`)
        .join("\n");
      const winLines = (p.key_wins ?? []).map((w) => `- ${w}`).join("\n");
      const tools = (p.tools_used ?? []).join(", ") || "—";
      const wins = p.key_wins ?? [];
      const toolsList = (p.tools_used ?? []).join(", ");
      const promptLines = [`I want to build: ${p.goal}`, ``];
      if (toolsList) promptLines.push(`Tools to use: ${toolsList}`, ``);
      if (wins.length) {
        promptLines.push(`What worked:`);
        wins.forEach((w) => promptLines.push(`- ${w}`));
        promptLines.push(``);
      }
      if (p.one_line_learning) promptLines.push(`Key learning: ${p.one_line_learning}`, ``);
      promptLines.push(`Help me build my version.`);
      const claudePrompt = promptLines.join("\n");
      // Save prompt back to projects table so the shipped card UI can display it
      try {
        await db(
          `projects?id=eq.${args.project_id as string}`,
          "PATCH",
          { copy_prompt: claudePrompt }
        );
      } catch {
        // best effort — don't fail the tool call if the write fails
      }
      const doc = [
        `# ${p.name}`,
        `**Goal:** ${p.goal}`,
        `**Tools used:** ${tools}`,
        ``,
        `## What was built`,
        entryLines || "_No entries_",
        ``,
        `## What was learned`,
        winLines || "_No wins recorded_",
        `**One-line learning:** ${p.one_line_learning ?? "—"}`,
        ``,
        `---`,
        `*Paste this into Claude:*`,
        claudePrompt,
      ].join("\n");
      return doc;
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
