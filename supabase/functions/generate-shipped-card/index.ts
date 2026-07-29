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
        if (e.raw_transcript) parts.push(`Raw: ${e.raw_transcript}`);
        if (e.claim) parts.push(`Claim: ${e.claim}`);
        if (e.tool_tags?.length) parts.push(`Tools: ${e.tool_tags.join(", ")}`);
        return parts.join("\n");
      })
      .join("\n\n");

    const systemPrompt = `You are analysing a builder's project entries to generate a shipped card.

Use only plain ASCII hyphens (-) in all output. Never use em dashes (—) or en dashes (–) anywhere in any field.

Each entry below has a raw version and a compressed one-line claim. Raw entries are your primary evidence - mine them for the specific detail that makes a decision credible: numbers, names, what was considered and rejected. Claims are a fast anchor for what the core decision was, not a source of detail - use them to orient, not to quote. Raw entries may be messy (voice-dictated, mid-thought, informal); that is fine, but write every field below in clean, structured prose regardless of how rough the source is.

First, identify the single most significant decision in this build and write it up across five fields. Write like a well-researched, well-sourced article: clear, specific, and grounded in what the entries actually say - not like a generic AI summary or marketing copy.

- core_problem: the specific business problem being solved, in plain language a stranger would understand (not "improve performance," but what was actually broken or unclear).
- core_evidence: what data, signal, or observation drove the decision. This is what separates a judgment call from a guess.
- core_decision: what was actually decided or done, framed as a single decision.
- rejected_alternatives: what else was considered and why it lost. If the entries don't show an explicit rejected alternative, say "no alternative was directly considered" rather than inventing one.
- outcome_or_learning: lead with a measured outcome if one exists. If there isn't one yet, say so directly and give the learning instead. Never fabricate a result.

Rules for the five fields above:
- Every field must be traceable to something in the entries. Do not invent details, metrics, or outcomes that aren't supported by them.
- Avoid empty superlatives ("game-changing," "seamless," "powerful"). If something worked, say specifically what changed and why.

From the entries, also extract:
- tools_used: array of any tools, APIs, or technologies mentioned across all entries
- narrative: 2 to 3 sentences written in first person, plain and concrete. Explain what was built and why it mattered in terms a non-technical reader coming in cold would understand. No marketing language, no exclamation marks, no hype words. Do not repeat the goal verbatim. It complements the five-field decision record above - it does not repeat it.
- summary: 3 to 5 sentences OR 3 to 5 bullet points describing what this build IS in plain language a stranger could understand. This is different from "goal" (what the builder was trying to achieve). The summary is the "what is this" elevator description that helps a reader immediately understand the build. If the build is simple, 3 sentences of prose is fine. If it has multiple components or steps, use 3-5 bullet points. When using bullets, separate them with newlines so the frontend can detect and render them as a list. Example: "An ICP synthesizer that turns raw sales call transcripts into a structured 6-section persona doc. Every claim is grounded in a direct quote from the calls, no invention or paraphrase. The build is portable: the same prompt works on any messy human voice data including interviews, forum posts, and customer emails."

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
  "core_problem": string,
  "core_evidence": string,
  "core_decision": string,
  "rejected_alternatives": string,
  "outcome_or_learning": string,
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
        max_tokens: 1600,
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

    let parsed: {
      core_problem: string;
      core_evidence: string;
      core_decision: string;
      rejected_alternatives: string;
      outcome_or_learning: string;
      tools_used: string[];
      narrative: string;
      summary: string;
      rewritten_goal: string;
      copy_prompt: string;
    };
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error("JSON parse failed, raw:", raw);
      parsed = {
        core_problem: "",
        core_evidence: "",
        core_decision: "",
        rejected_alternatives: "",
        outcome_or_learning: "",
        tools_used: [],
        narrative: "",
        summary: "",
        rewritten_goal: project.goal ?? project.name,
        copy_prompt: `I want to build:\n${project.goal ?? project.name}\n\nHelp me build my version, adapted to my context.\n\nOriginal build by ${displayName} on Receipts.\nSee the full build at https://receipts.tools/shipped/${project_id}`,
      };
    }

    // Update project row; rewritten_goal overwrites the goal column
    // key_wins / one_line_learning are intentionally left untouched here -
    // they're only ever populated by the old pre-rebuild extraction, kept
    // for cards shipped before this change that haven't been regenerated.
    const { data: updated, error: updateError } = await supabase
      .from("projects")
      .update({
        core_problem: parsed.core_problem ?? "",
        core_evidence: parsed.core_evidence ?? "",
        core_decision: parsed.core_decision ?? "",
        rejected_alternatives: parsed.rejected_alternatives ?? "",
        outcome_or_learning: parsed.outcome_or_learning ?? "",
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
