const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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

  let transcript: string;
  let tool_tags: string[];

  try {
    const body = await req.json();
    transcript = body.transcript;
    tool_tags = body.tool_tags ?? [];

    if (!transcript || typeof transcript !== "string") {
      return new Response(JSON.stringify({ error: "Missing or invalid 'transcript' field" }), {
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

  const wordCount = transcript.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount < 10) {
    return new Response(JSON.stringify({ skip: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const userMessage = tool_tags.length > 0
    ? `${transcript}\n\nTool tags: ${tool_tags.join(", ")}`
    : transcript;

  const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system:
        `You are a build logger. Given a raw note from someone building with AI, return a JSON object with exactly these fields:

- claim: one punchy sentence capturing what happened (past tense, specific, no filler). Respond in the same language as the input transcript.
- entry_type: one of build / decision / idea / shipped / dropped / log
- tags: array of 1-3 short lowercase kebab-case tags describing the topic, audience, or intent. Examples: product-questions, commercial-signals, icp-research, explore-beta, usability-feedback, pricing-concern. Infer from content. Never leave empty.

Return only valid JSON. No markdown. No backticks. No explanation. If the input is too short or is a greeting, return: {"claim":"A note was logged.","entry_type":"log","tags":["general"]}`,
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
  const rawText: string = anthropicData.content?.[0]?.text?.trim() ?? "";

  let claim = "";
  let entry_type = "build";
  let tags: string[] = [];

  try {
    const stripped = rawText
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();
    const parsed = JSON.parse(stripped);
    claim = parsed.claim ?? "";
    entry_type = parsed.entry_type ?? "build";
    tags = Array.isArray(parsed.tags) ? parsed.tags : [];
  } catch {
    claim = rawText;
  }

  const project_tag: string | null = tool_tags.length > 0 ? tool_tags[0] : null;

  return new Response(
    JSON.stringify({ claim, project_tag, entry_type, tags }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
});
