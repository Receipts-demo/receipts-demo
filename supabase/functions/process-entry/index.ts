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
      model: "claude-sonnet-4-20250514",
      max_tokens: 200,
      system:
        "You are a professional build logger. Take this raw note and turn it into a single precise claim statement - one sentence describing what was built, decided, or originated, written as professional evidence. Return only the claim, nothing else. Respond in the same language as the input transcript. If the transcript is in German, write the claim in German. If in English, write in English.",
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
  const claim: string = anthropicData.content?.[0]?.text?.trim() ?? "";

  // Derive project_tag from the first tool_tag if present, otherwise null
  const project_tag: string | null = tool_tags.length > 0 ? tool_tags[0] : null;

  // Derive entry_type heuristically from the claim text
  const lowerClaim = claim.toLowerCase();
  let entry_type: string;
  if (lowerClaim.includes("decided") || lowerClaim.includes("decision")) {
    entry_type = "decision";
  } else if (lowerClaim.includes("originated") || lowerClaim.includes("created") || lowerClaim.includes("established")) {
    entry_type = "origin";
  } else {
    entry_type = "build";
  }

  return new Response(
    JSON.stringify({ claim, project_tag, entry_type }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
});
