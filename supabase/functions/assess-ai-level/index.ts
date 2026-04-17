import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SYSTEM_PROMPT = `You are assessing someone's AI Native level based on two answers.

Levels:
1 - The Curious: Knows about AI, hasn't built much yet
2 - The Prompt Whisperer: Gets more out of AI than most, understands prompting
3 - The Vibe Coder: Ships things with AI without fully understanding how they work
4 - The Agent Architect: Builds systems and automations that run independently
5 - Lord of AI: AI is deeply embedded in everything they do, building at the frontier

From their answers extract:
- level (1-5 integer)
- level_title (exact title from above)
- role_category (one of: Sales, Marketing, Operations, Product, Engineering, Design, Research, Finance, Other - extract from context, never guess)
- company_context (company name if clearly stated, 'on the side' for side projects/spare time, 'independently' for freelance, omit entirely if unclear)
- streaming_analysis (2-3 sentences, personal and specific to their answers, builds anticipation for the reveal - reference something concrete from what they said)
- personalised_tagline (one punchy line specific to them for their profile card - if answers are too vague fall back to null)

Rules:
- If answers are too short or vague to make a confident assessment, default level to 2
- Never invent or assume company names
- Never make the user look strange on their profile card
- Return ONLY valid JSON, no other text

Return this exact JSON structure:
{
  "level": number,
  "level_title": string,
  "role_category": string,
  "company_context": string | null,
  "streaming_analysis": string,
  "personalised_tagline": string | null
}`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const supabaseClient = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    {
      global: {
        headers: { Authorization: req.headers.get('Authorization') ?? '' },
      },
    }
  );

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let q1: string;
  let q2: string;

  try {
    const body = await req.json();
    q1 = body.q1;
    q2 = body.q2;

    if (!q1 || !q2 || typeof q1 !== "string" || typeof q2 !== "string") {
      return new Response(JSON.stringify({ error: "Missing or invalid 'q1' or 'q2' fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const userMessage = `Q1 - What's your role and what do you do day to day?\n${q1}\n\nQ2 - Tell me one thing you've built with AI so far.\n${q2}`;

  const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    return new Response(JSON.stringify({ error: "Anthropic API error", detail: errText }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const anthropicData = await anthropicRes.json();
  const raw: string = anthropicData.content?.[0]?.text?.trim() ?? "";

  let parsed: unknown;
  try {
    // Strip markdown code fences if present
    const cleaned = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return new Response(JSON.stringify({ error: "Failed to parse Claude response", raw }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify(parsed), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
