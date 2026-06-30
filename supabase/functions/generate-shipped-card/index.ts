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
      .select("id, name, goal, status, created_at, owner_id, shipped_at")
      .eq("id", project_id)
      .single();

    if (projectError || !project) {
      throw new Error(`Project not found: ${projectError?.message}`);
    }

    // Fetch display_name for attribution line in copy_prompt
    const { data: builderProfile } = await supabase
      .from("profiles")
      .select("display_name")
      .eq("id", project.owner_id)
      .single();

    const displayName = builderProfile?.display_name ?? "A Receipts builder";

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

Use only plain ASCII hyphens (-) in all output. Never use em dashes (—) or en dashes (–) anywhere in the copy_prompt, narrative, key_wins, or any other field.

From the entries provided, extract:
- key_wins: array of exactly 3 short punchy wins (max 12 words each). These should be specific and concrete, referencing what was actually built or achieved.
- one_line_learning: one honest sentence about the most important thing learned (max 20 words)
- tools_used: array of any tools, APIs, or technologies mentioned across all entries
- narrative: 2 to 3 sentences written in first person, plain and concrete. Explain what was built and why it mattered in terms a non-technical reader coming in cold would understand. No marketing language, no exclamation marks, no hype words. Do not repeat the goal verbatim. It complements the key wins - it does not list them.
- summary: 3 to 5 sentences OR 3 to 5 bullet points describing what this build IS in plain language a stranger could understand. This is different from "goal" (what the builder was trying to achieve) and different from "key_wins" (what specifically worked). The summary is the "what is this" elevator description that helps a reader immediately understand the build. If the build is simple, 3 sentences of prose is fine. If it has multiple components or steps, use 3-5 bullet points. When using bullets, separate them with newlines so the frontend can detect and render them as a list. Example: "An ICP synthesizer that turns raw sales call transcripts into a structured 6-section persona doc. Every claim is grounded in a direct quote from the calls, no invention or paraphrase. The build is portable: the same prompt works on any messy human voice data including interviews, forum posts, and customer emails."

Also produce a "rewritten_goal" field. The original goal in the project record may be a half-formed early thought ("add custom connector"). Rewrite it as 1-2 clear sentences that describe what the builder set out to do, based on the entries. A stranger should understand the goal without context.

Example: instead of "add custom connector and log entries," write "Build a browser-based MCP connector for Receipts so users can authenticate and use Receipts MCP tools from claude.ai without any terminal setup."

Produce a "copy_prompt" field. This is NOT a summary - it is a ready-to-paste prompt for a NEW builder who wants to build something similar. They will paste it into Claude and immediately start building. The prompt must be self-contained and actionable for someone who has never seen this build.

Structure (use these exact section headers in the output):

I want to build:
[The rewritten_goal, but adapted to be in first person and stated as the builder's intent. Specific enough that a stranger understands the deliverable.]

Recommended approach:
[2-4 sentences of guidance pulled from what worked. Frame as advice for a stranger, not retrospective. Reference specific tools and techniques that mattered. Avoid jargon shorthand - spell things out.]

Trade-offs to know:
[The 1-2 non-obvious learnings the original builder discovered that would save the new builder time or pain. Specific, not generic. Avoid platitudes like "iteration is important."]

Help me build my version, adapted to my context.

At the very end of the copy_prompt (after the "Help me build my version, adapted to my context." line), append the following attribution using the builder_display_name and project_id values from the context below - substitute them exactly, do not use placeholders:

Original build by [builder_display_name] on Receipts.
See the full build at https://receipts.tools/shipped/[project_id]

Return ONLY valid JSON:
{
  "key_wins": string[],
  "one_line_learning": string,
  "tools_used": string[],
  "narrative": string,
  "summary": string,
  "rewritten_goal": string,
  "copy_prompt": string
}`;

    const userMsg = `Project: ${project.name}\nGoal: ${project.goal ?? "Not specified"}\nProject ID: ${project_id}\nBuilder display name: ${displayName}\n\nEntries:\n${entryText || "No entries recorded."}`;

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1200,
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

    let parsed: { key_wins: string[]; one_line_learning: string; tools_used: string[]; narrative: string; summary: string; rewritten_goal: string; copy_prompt: string };
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error("JSON parse failed, raw:", raw);
      parsed = {
        key_wins: ["Project shipped", "Work completed", "Goal achieved"],
        one_line_learning: "Every build teaches something new.",
        tools_used: [],
        narrative: "",
        summary: "",
        rewritten_goal: project.goal ?? project.name,
        copy_prompt: `I want to build:\n${project.goal ?? project.name}\n\nHelp me build my version, adapted to my context.\n\nOriginal build by ${displayName} on Receipts.\nSee the full build at https://receipts.tools/shipped/${project_id}`,
      };
    }

    // Update project row; rewritten_goal overwrites the goal column
    const { data: updated, error: updateError } = await supabase
      .from("projects")
      .update({
        key_wins: parsed.key_wins ?? [],
        one_line_learning: parsed.one_line_learning ?? "",
        tools_used: parsed.tools_used ?? [],
        narrative: parsed.narrative ?? "",
        summary: parsed.summary ?? "",
        copy_prompt: parsed.copy_prompt ?? "",
        goal: parsed.rewritten_goal ?? project.goal,
        shipped_at: project.shipped_at ?? new Date().toISOString(),
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
