const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Auth — caller must be a signed-in user
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const userId = token ? await resolveUser(token) : null;
  if (!userId) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let raw_text: string;
  let project_id: string | null;
  let transcript_type: string;
  let sharedRequested: boolean;
  let duration_seconds: number | null;

  try {
    const body = await req.json();
    raw_text = body.raw_text;
    project_id = body.project_id ?? null;
    transcript_type = body.transcript_type;
    sharedRequested = body.shared === true;
    duration_seconds = typeof body.duration_seconds === "number" ? body.duration_seconds : null;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!raw_text || typeof raw_text !== "string" || raw_text.trim().length === 0) {
    return new Response(JSON.stringify({ error: "raw_text is required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!["meeting", "personal_note"].includes(transcript_type)) {
    return new Response(
      JSON.stringify({ error: "transcript_type must be 'meeting' or 'personal_note'" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // ----------------------------------------------------------------
  // Pass the caller's shared intent through to the insert.
  // The database trigger (enforce_transcript_shared_flag) is the
  // authoritative enforcement point — it runs on every INSERT and
  // UPDATE and silently forces shared = false if the project isn't
  // 'Shared' status, the transcript_type is 'personal_note', or
  // there's no project_id. We read back the inserted row to detect
  // whether the trigger corrected the value, then surface that via
  // shared_forced_false so the frontend can show a message.
  // ----------------------------------------------------------------
  const shared = sharedRequested;

  // Claude Haiku — generate title, summary, suggested_tags
  const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
  if (!ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const systemPrompt = `You are organising a transcript captured by someone building with AI tools.

Your job is NOT to summarise or compress the transcript. raw_text is permanent and is never modified.
You are producing three navigation aids that sit alongside raw_text:

- title: a specific, scannable label for this transcript. Include person/company/topic where present.
  Bad: "Meeting Notes", "Team Call", "Notes". Good: "Pricing objection call with Klimate", "Onboarding Q&A with Henrik", "Thoughts on MCP connector auth flow".
  Max 10 words. No quotes around it.
- summary: 2-3 sentences describing what was discussed or thought through. Enough context to decide
  whether to open the full transcript. Not a replacement for it.
- suggested_tags: 2-4 short lowercase kebab-case tags. Examples: pricing-concern, onboarding-flow,
  technical-decision, team-meeting, personal-notes, product-strategy.

Return ONLY valid JSON. No markdown. No backticks. No explanation.
{
  "title": string,
  "summary": string,
  "suggested_tags": string[]
}`;

  const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: "user", content: raw_text }],
    }),
  });

  let title = "";
  let summary = "";
  let suggested_tags: string[] = [];

  if (claudeRes.ok) {
    const claudeData = await claudeRes.json();
    const rawOutput: string = claudeData.content?.[0]?.text?.trim() ?? "";
    try {
      const cleaned = rawOutput
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();
      const parsed = JSON.parse(cleaned);
      title = (parsed.title ?? "").replace(/`/g, "").trim();
      summary = (parsed.summary ?? "").replace(/`/g, "").trim();
      suggested_tags = Array.isArray(parsed.suggested_tags) ? parsed.suggested_tags : [];
    } catch {
      // Claude output unparseable — save the transcript without metadata;
      // user can edit title manually (spec says title is always editable)
      console.error("process-transcript: JSON parse failed, raw:", rawOutput);
    }
  } else {
    console.error("process-transcript: Anthropic error", claudeRes.status, await claudeRes.text());
  }

  // Insert transcript row — always succeeds even if Claude failed above
  const insertBody = {
    owner_id: userId,
    project_id: project_id ?? null,
    transcript_type,
    title: title || null,
    summary: summary || null,
    raw_text,
    duration_seconds,
    shared,
  };

  const insertRes = await fetch(
    `${SUPABASE_URL}/rest/v1/transcripts`,
    {
      method: "POST",
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(insertBody),
    },
  );

  if (!insertRes.ok) {
    const errText = await insertRes.text();
    console.error("process-transcript: insert failed", insertRes.status, errText);
    return new Response(JSON.stringify({ error: "Failed to save transcript", detail: errText }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const [transcript] = await insertRes.json();

  // If the trigger downgraded shared, tell the frontend the specific reason
  // so it can name it rather than silently reverting the toggle.
  //   "personal_note"      → personal notes are always private
  //   "no_project"         → no project assigned, no audience to scope to
  //   "project_not_shared" → project exists but its status isn't 'Shared'
  let shared_forced_reason: string | null = null;
  if (sharedRequested && transcript.shared === false) {
    if (transcript_type === "personal_note") {
      shared_forced_reason = "personal_note";
    } else if (!project_id) {
      shared_forced_reason = "no_project";
    } else {
      shared_forced_reason = "project_not_shared";
    }
  }

  return new Response(
    JSON.stringify({ ...transcript, suggested_tags, shared_forced_reason }),
    { status: 201, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
