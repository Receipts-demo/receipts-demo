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

  const apiKey = Deno.env.get("GOODTAPE_API_KEY");
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "GOODTAPE_API_KEY not configured" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let audioBytes: ArrayBuffer;
  try {
    audioBytes = await req.arrayBuffer();
    if (audioBytes.byteLength === 0) {
      return new Response(JSON.stringify({ error: "Empty audio body" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  } catch {
    return new Response(JSON.stringify({ error: "Failed to read audio body" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const contentType = req.headers.get("content-type") ?? "audio/webm";
  const form = new FormData();
  form.append("audio", new Blob([audioBytes], { type: contentType }), "audio");

  const goodTapeRes = await fetch("https://api.goodtape.io/transcribe/sync", {
    method: "POST",
    headers: {
      Authorization: apiKey,
    },
    body: form,
  });

  if (!goodTapeRes.ok) {
    const errText = await goodTapeRes.text();
    return new Response(JSON.stringify({ error: "Good Tape API error", detail: errText }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const result = await goodTapeRes.json();

  // Good Tape returns { text: "..." } — pass it through directly
  const text: string = result.text ?? result.transcript ?? "";

  return new Response(JSON.stringify({ text }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
