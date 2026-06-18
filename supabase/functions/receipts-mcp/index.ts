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
    title: "Log a build entry",
    description: `Use this to log a single moment, decision, or piece of progress to a build.
One entry = one moment. Do not bundle multiple decisions into one entry.

Trigger phrases: "log this", "save this to X", "add an entry", "note this down",
"capture this decision", "record what I just did", "log my progress on X".

Workflow rule: ALWAYS call get_my_builds first if you don't have an exact
project_id. Never guess a project_id from a name - confirm it first.

Good entry: "Decided to use Supabase over Firebase because of row-level security."
Bad entry: "Worked on the project today."

The text should capture the decision or action and the reason behind it, in the
user's own words. Encourage specificity but don't rewrite what they said.`,
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
    name: "delete_entry",
    title: "Delete a build entry",
    description: `Use this to delete a specific entry from a build.
Always call get_entries first to confirm the entry_id and show
the user what will be deleted before calling this tool.
Never delete without confirming with the user which entry is being removed.
One entry deleted cannot be recovered.`,
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        entry_id: { type: "string", description: "UUID of the entry to delete" },
      },
      required: ["entry_id"],
    },
  },
  {
    name: "get_my_builds",
    title: "Get my builds",
    description: `Use this to find, get, fetch, retrieve, list, show, grab, pull up, or browse
the user's builds. Call this whenever the user wants to see their work in any
form - even if they haven't said "search."

Trigger phrases include (but are not limited to):
"what builds do I have", "show me my projects", "what am I working on",
"get my builds", "fetch my builds", "grab my builds", "find my builds",
"bring up my builds", "what have I built", "list my work", "overview of my builds",
"which build should I log to", "what's in Receipts", "open Receipts".

Workflow rule: always call this BEFORE log_entry when the user hasn't provided
an exact project_id. Confirm the correct build with the user before logging.

Pass an empty string or broad term to return all builds.
Pass a name fragment to filter by name or tools used.`,
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "update_build_status",
    title: "Update build status",
    description: `Use this to change the status of a build. Valid statuses are:
"In Progress", "Paused", "Shipped", "Dropped".

Trigger phrases: "mark X as shipped", "I shipped X", "pause X", "drop X",
"X is done", "archive X", "I finished X", "update status of X".

Workflow rule: when the user says a build is done or shipped, suggest generating
a shipped card via the app before updating status - the narrative and key wins
are generated at ship time and can't be recovered from status alone.

Confirm the correct build with get_my_builds before updating if project_id
is not provided.`,
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
    title: "Add an idea",
    description: `Use this to capture an idea before it becomes a build. Ideas live in the
Ideas tab in Receipts - they are not builds yet.

Trigger phrases: "add an idea", "save this idea", "note this for later",
"I had a thought about X", "capture this before I forget", "idea: X".

Keep the text as close to what the user said as possible. Don't over-structure.
An idea is raw material, not a polished brief.

If the user wants to turn an idea into a build immediately, use create_build
instead and skip add_idea.`,
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
    title: "Create a build",
    description: `Use this to start a new build, project, or piece of work in Receipts.
Call this when the user wants to create something new to track.

Trigger phrases: "create a build", "start a new project", "add a build called X",
"I want to track X", "new build for X", "set up a project for X".

The goal field is important - push back on vague goals. A good goal names a
specific deliverable a stranger could understand: not "work on marketing" but
"build a cold email sequence that books 5 demos a week." Reject stub goals.

Default status is "In Progress". Only set status to "Shipped" when the user
explicitly says the build is done.`,
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
    title: "Get build entries",
    description: `Use this to show the history, entries, logs, or timeline of a specific build.
Call this when the user wants to see what they've captured inside a build,
review their progress, or understand what's already been logged.

Trigger phrases: "what have I logged on X", "show me the entries for X",
"what's in this build", "review my progress on X", "history of X".

Workflow rule: call get_my_builds first if you don't have the project_id.
Returns entries ordered oldest to newest - good for reading a build's story.`,
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
    title: "Get shipped card",
    description: `Use this to read a finished shipped card for any build - yours or a teammate's.
Call this when the user wants to see the summary, key wins, learnings, or tools
used on a completed build.

Trigger phrases: "show me the card for X", "what did we ship on X",
"read the shipped card", "what were the key wins on X", "summarise build X".

Note: no ownership filter - any shipped card is readable by anyone in the workspace.
This is by design. Shipped cards are public proof of work.`,
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
    title: "Search my builds",
    description: `Use this to search across all of the user's own builds by name or keyword.
Broader than get_my_builds - optimised for keyword matching rather than browsing.

Trigger phrases: "search my builds for X", "find builds about X",
"any builds involving X", "which of my builds used X tool",
"do I have anything on X".

Pass a query of 2+ characters to filter by name or tools used.
Pass an empty string or single character to return ALL builds (broad browse intent).

Scope: caller's own builds only. For team search, use search_workspace_cards.`,
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
    title: "Copy a build",
    description: `Use this to get a ready-to-paste prompt for replicating a build. Returns a
structured document with the goal, recommended approach, trade-offs, and a
prompt the user can paste into a new Claude conversation to start building.

Trigger phrases: "copy this build", "I want to build something like X",
"how did X build Y", "replicate build X", "use X as a template",
"start from the same approach as X".

No ownership filter - any build can be copied by any workspace member.
This is intentional: copying is how knowledge spreads through a team.

After returning the copy prompt, tell the user to paste it into a new
Claude conversation to start building their version.`,
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "UUID of the project to copy" },
      },
      required: ["project_id"],
    },
  },
  {
    name: "search_workspace_cards",
    title: "Search workspace builds",
    description: `Use this to search shipped builds across the entire workspace - not just the
caller's own work. Returns cards from all team members who have shipped builds.

Trigger phrases: "search the team's work for X", "find workspace builds about X",
"what has the team shipped on X", "any team builds using X",
"search across the workspace", "find shared builds about X",
"what's been shipped here on X".

Filters by name, goal, or tools used. Returns project_id, name, goal,
tools_used, top key win, and one-line learning for each match.

Scope: whole workspace, shipped builds only. Drafts and in-progress builds
are not included. For the user's own unshipped work, use search_builds.`,
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term — matched against build name, goal, and tools used" },
      },
      required: ["query"],
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

    case "delete_entry": {
      const deleted = await db(
        `entries?id=eq.${args.entry_id as string}&owner_id=eq.${userId}`,
        "DELETE"
      ) as Array<{ id: string }>;
      if (!Array.isArray(deleted) || !deleted.length) {
        return `Entry not found or does not belong to you. No entry was deleted.`;
      }
      return `Entry deleted. ID: ${args.entry_id as string}`;
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
        .map((e) => `[${e.entry_type ?? "log"}] ${e.created_at.slice(0, 10)}: ${e.claim ?? e.raw_transcript}  (id: ${e.id})`)
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
      const matches = q.length < 2 ? projects : projects.filter((p) =>
        p.name.toLowerCase().includes(q) ||
        (p.tools_used ?? []).some((t) => t.toLowerCase().includes(q))
      );
      if (!matches.length) return q.length < 2 ? "No builds found." : `No builds found matching "${args.query as string}".`;
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

    case "search_workspace_cards": {
      const profiles = await db(
        `profiles?id=eq.${userId}&select=workspace_id`,
        "GET"
      ) as Array<{ workspace_id: string | null }>;
      const workspaceId = profiles[0]?.workspace_id ?? null;
      if (!workspaceId) return "You are not a member of any workspace.";

      const feedRows = await db(
        `workspace_feed?workspace_id=eq.${workspaceId}&event_type=eq.shipped&select=project_id`,
        "GET"
      ) as Array<{ project_id: string }>;
      if (!feedRows.length) return "No shipped builds found in your workspace.";

      const ids = feedRows.map((r) => r.project_id).join(",");
      const projects = await db(
        `projects?id=in.(${ids})&select=id,name,goal,tools_used,key_wins,one_line_learning`,
        "GET"
      ) as Array<{
        id: string;
        name: string;
        goal: string | null;
        tools_used: string[] | null;
        key_wins: string[] | null;
        one_line_learning: string | null;
      }>;

      const q = (args.query as string).toLowerCase();
      const matches = projects.filter((p) =>
        p.name.toLowerCase().includes(q) ||
        (p.goal ?? "").toLowerCase().includes(q) ||
        (p.tools_used ?? []).some((t) => t.toLowerCase().includes(q))
      );
      if (!matches.length) return `No workspace builds found matching "${args.query as string}".`;
      return matches.map((p) => {
        const tools = (p.tools_used ?? []).join(", ") || "—";
        const topWin = p.key_wins?.[0] ?? "—";
        return [
          `• ${p.name}  (id: ${p.id})`,
          `  Goal: ${p.goal ?? "—"}`,
          `  Tools: ${tools}`,
          `  Top win: ${topWin}`,
          `  Learning: ${p.one_line_learning ?? "—"}`,
        ].join("\n");
      }).join("\n\n");
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
