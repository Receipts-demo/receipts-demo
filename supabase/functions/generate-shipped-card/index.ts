import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { project_id } = await req.json();
    if (!project_id) {
      return new Response(JSON.stringify({ error: "project_id is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
    if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not configured");

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Supabase env vars not configured");

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Fetch project
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id, name, goal, status, created_at")
      .eq("id", project_id)
      .single();

    if (projectError || !project) {
      throw new Error(`Project not found: ${projectError?.message}`);
    }

    // Fetch all entries for the project
    const { data: entries, error: entriesError } = await supabase
      .from("entries")
      .select("raw_transcript, claim, entry_type, tool_tags, recorded_at")
      .eq("project_id", project_id)
      .order("recorded_at", { ascending: true });

    if (entriesError) throw new Error(`Entries fetch failed: ${entriesError.message}`);

    const entryText = (entries ?? [])
      .map((e, i) => {
        const parts = [`Entry ${i + 1} (${e.entry_type ?? "log"})`];
        if (e.claim) parts.push(`Claim: ${e.claim}`);
        else if (e.raw_transcript) parts.push(`Transcript: ${e.raw_transcript}`);
        if (e.tool_tags?.length) parts.push(`Tools: ${e.tool_tags.join(", ")}`);
        return parts.join("\n");
      })
      .join("\n\n");

    const systemPrompt = `You are analysing a builder's project entries to generate a shipped card.

From the entries provided, extract:
- key_wins: array of exactly 3 short punchy wins (max 12 words each). These should be specific and concrete, referencing what was actually built or achieved.
- one_line_learning: one honest sentence about the most important thing learned (max 20 words)
- tools_used: array of any tools, APIs, or technologies mentioned across all entries

Return ONLY valid JSON:
{
  "key_wins": string[],
  "one_line_learning": string,
  "tools_used": string[]
}`;

    const userMsg = `Project: ${project.name}\nGoal: ${project.goal ?? "Not specified"}\n\nEntries:\n${entryText || "No entries recorded."}`;

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        system: systemPrompt,
        messages: [{ role: "user", content: userMsg }],
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      console.error("Anthropic API error:", claudeRes.status, errText);
      throw new Error(`Anthropic API returned ${claudeRes.status}`);
    }

    const claudeResult = await claudeRes.json();
    const raw = claudeResult.content?.[0]?.text?.trim() ?? "";
    const cleaned = raw
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    let parsed: { key_wins: string[]; one_line_learning: string; tools_used: string[] };
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error("JSON parse failed, raw:", raw);
      parsed = {
        key_wins: ["Project shipped", "Work completed", "Goal achieved"],
        one_line_learning: "Every build teaches something new.",
        tools_used: [],
      };
    }

    const wins = parsed.key_wins ?? [];
    const toolsList = (parsed.tools_used ?? []).join(", ");
    const promptLines = [`I want to build: ${project.goal ?? project.name}`, ``];
    if (toolsList) promptLines.push(`Tools to use: ${toolsList}`, ``);
    if (wins.length) {
      promptLines.push(`What worked:`);
      wins.forEach((w) => promptLines.push(`- ${w}`));
      promptLines.push(``);
    }
    if (parsed.one_line_learning) promptLines.push(`Key learning: ${parsed.one_line_learning}`, ``);
    promptLines.push(`Help me build my version.`);
    const copyPrompt = promptLines.join("\n");

    // Update project row
    const { data: updated, error: updateError } = await supabase
      .from("projects")
      .update({
        key_wins: parsed.key_wins ?? [],
        one_line_learning: parsed.one_line_learning ?? "",
        tools_used: parsed.tools_used ?? [],
        copy_prompt: copyPrompt,
        shipped_at: new Date().toISOString(),
        status: "Shipped",
      })
      .eq("id", project_id)
      .select()
      .single();

    if (updateError) throw new Error(`Project update failed: ${updateError.message}`);
    console.log("project updated:", JSON.stringify({ id: updated.id, status: updated.status, owner_id: updated.owner_id }));

    // Post to workspace_feed if the project owner has a workspace
    console.log("fetching profile for owner_id:", updated.owner_id);
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("workspace_id")
      .eq("id", updated.owner_id)
      .single();

    console.log("profile fetch result:", JSON.stringify({ workspace_id: profile?.workspace_id, error: profileError?.message ?? null }));

    if (!profile?.workspace_id) {
      console.log("no workspace_id on profile — skipping workspace_feed insert");
    } else {
      console.log("inserting workspace_feed row:", JSON.stringify({
        workspace_id: profile.workspace_id,
        user_id: updated.owner_id,
        project_id: project_id,
        event_type: "shipped",
      }));
      const { data: feedData, error: feedError } = await supabase
        .from("workspace_feed")
        .insert({
          workspace_id: profile.workspace_id,
          user_id: updated.owner_id,
          project_id: project_id,
          event_type: "shipped",
        })
        .select();
      console.log("workspace_feed insert result:", JSON.stringify({ data: feedData, error: feedError?.message ?? null }));
    }

    return new Response(JSON.stringify(updated), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("generate-shipped-card error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
