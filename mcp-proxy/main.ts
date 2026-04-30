/// <reference lib="deno.unstable" />

// ─── Constants ────────────────────────────────────────────────────────────────

const SUPABASE_URL = "https://kxkynhbulfxkibwmwrwl.supabase.co";
const SUPABASE_MCP = `${SUPABASE_URL}/functions/v1/receipts-mcp`;
const MCP_URL = "https://mcp.receipts.tools";
const APP_LOGIN_URL = "https://receipts.tools/login";
const CONSENT_URL = "https://receipts.tools/oauth/consent";

// Set SUPABASE_ANON_KEY in Deno Deploy env vars to enable token validation at callback.
// The anon key is safe to expose — it's already in the frontend JS bundle.
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const KV_TTL = 10 * 60 * 1000; // 10 minutes in milliseconds

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-session-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// ─── Deno KV ─────────────────────────────────────────────────────────────────

const kv = await Deno.openKv();

// ─── Types ────────────────────────────────────────────────────────────────────

interface AuthRequest {
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
  access_token?: string; // populated after /oauth/callback
}

interface AuthCode {
  access_token: string;
  code_challenge: string;
  code_challenge_method: string;
  client_id: string;
  redirect_uri: string;
  state: string;
}

// ─── Crypto Helpers ───────────────────────────────────────────────────────────

// PKCE S256: base64url(SHA-256(ascii(code_verifier)))
async function sha256Base64Url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hash);
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function randomHex(bytes = 32): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Supabase Token Validation ────────────────────────────────────────────────

async function validateSupabaseToken(token: string): Promise<boolean> {
  if (!SUPABASE_ANON_KEY) return true; // skip validation if no key configured
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: SUPABASE_ANON_KEY,
    },
  });
  return res.ok;
}

// ─── Response Helpers ─────────────────────────────────────────────────────────

function jsonError(status: number, error: string, description?: string): Response {
  return Response.json(
    { error, ...(description ? { error_description: description } : {}) },
    { status, headers: corsHeaders },
  );
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // ── OAuth Protected Resource Metadata ──────────────────────────────────────
  // claude.ai fetches this first to discover which authorization server to use.
  // We now point to ourselves (the proxy) instead of Supabase.
  if (path === "/.well-known/oauth-protected-resource") {
    return Response.json({
      resource: MCP_URL,
      authorization_servers: [MCP_URL],
      bearer_methods_supported: ["header"],
      scopes_supported: ["openid", "email"],
    }, { headers: corsHeaders });
  }

  // ── OAuth Authorization Server Metadata ────────────────────────────────────
  // Describes this proxy's OAuth endpoints. Replaces forwarding to Supabase.
  if (
    path === "/.well-known/oauth-authorization-server" ||
    path === "/.well-known/openid-configuration"
  ) {
    return Response.json({
      issuer: MCP_URL,
      authorization_endpoint: `${MCP_URL}/oauth/authorize`,
      token_endpoint: `${MCP_URL}/oauth/token`,
      registration_endpoint: `${MCP_URL}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["openid", "email"],
      token_endpoint_auth_methods_supported: ["none"],
    }, { headers: corsHeaders });
  }

  // ── Dynamic Client Registration ────────────────────────────────────────────
  // Accepts any client (claude.ai, Claude desktop, etc.) and stores in KV.
  // Per the plan: no pre-registration needed, store whatever arrives.
  if (path === "/oauth/register" && req.method === "POST") {
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch { /* ignore — treat as empty registration */ }

    const client_id = (body.client_id as string) || randomHex(16);
    await kv.set(["client", client_id], {
      client_id,
      client_name: body.client_name ?? "Unknown Client",
      redirect_uris: body.redirect_uris ?? [],
      registered_at: Date.now(),
    }); // no TTL — clients are persistent

    return Response.json({
      client_id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: body.redirect_uris ?? [],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      scope: "openid email",
    }, { status: 201, headers: corsHeaders });
  }

  // ── Authorization Endpoint ─────────────────────────────────────────────────
  // Step 1: claude.ai sends the user here with PKCE params.
  // We stash everything in KV, then send the user to the app login page.
  // The login page must redirect back to /oauth/callback after a successful login.
  //
  // Login page contract (implement in Lovable):
  //   - Detect query param `oauth_redirect`
  //   - Log the user in via Supabase (email/password)
  //   - On success: redirect to `{oauth_redirect}&access_token={supabase_jwt}`
  //   - If user has an existing session: redirect immediately without showing login UI
  if (path === "/oauth/authorize" && req.method === "GET") {
    const client_id = url.searchParams.get("client_id") ?? "";
    const redirect_uri = url.searchParams.get("redirect_uri") ?? "";
    const state = url.searchParams.get("state") ?? "";
    const code_challenge = url.searchParams.get("code_challenge") ?? "";
    const code_challenge_method = url.searchParams.get("code_challenge_method") ?? "S256";
    const response_type = url.searchParams.get("response_type") ?? "";

    if (!client_id || !redirect_uri || !state || !code_challenge) {
      return new Response("Bad Request: missing client_id, redirect_uri, state, or code_challenge", {
        status: 400,
      });
    }
    if (response_type !== "code") {
      return new Response("Bad Request: response_type must be 'code'", { status: 400 });
    }
    if (code_challenge_method !== "S256") {
      return new Response("Bad Request: only S256 code_challenge_method is supported", { status: 400 });
    }

    await kv.set(["auth", state], {
      client_id,
      redirect_uri,
      state,
      code_challenge,
      code_challenge_method,
    } as AuthRequest, { expireIn: KV_TTL });

    console.log("[authorize] stored state in KV:", state.slice(0, 12), "client_id:", client_id);

    // Pass the callback URL so the login page knows exactly where to send the token
    const callbackUrl = `${MCP_URL}/oauth/callback?state=${encodeURIComponent(state)}`;
    const loginUrl = new URL(APP_LOGIN_URL);
    loginUrl.searchParams.set("oauth_redirect", callbackUrl);

    console.log("[authorize] redirecting to login:", loginUrl.toString());
    return Response.redirect(loginUrl.toString(), 302);
  }

  // ── OAuth Callback ─────────────────────────────────────────────────────────
  // Step 2: the app login page redirects here after login with the Supabase JWT.
  // We validate the token, store it against the state, then send the user to
  // the consent page in Lovable.
  if (path === "/oauth/callback" && req.method === "GET") {
    const state = url.searchParams.get("state") ?? "";
    const access_token = url.searchParams.get("access_token") ?? "";

    if (!state || !access_token) {
      return new Response("Bad Request: missing state or access_token", { status: 400 });
    }

    console.log("[callback] received state:", state.slice(0, 12), "has_token:", !!access_token);

    const entry = await kv.get<AuthRequest>(["auth", state]);
    if (!entry.value) {
      console.log("[callback] error: state not found in KV:", state.slice(0, 12));
      return new Response("Bad Request: unknown or expired state — start the auth flow again", {
        status: 400,
      });
    }

    const valid = await validateSupabaseToken(access_token);
    if (!valid) {
      console.log("[callback] error: invalid Supabase token");
      return new Response("Unauthorized: invalid Supabase token", { status: 401 });
    }

    // Attach the token to the stored auth request
    await kv.set(["auth", state], {
      ...entry.value,
      access_token,
    } as AuthRequest, { expireIn: KV_TTL });

    console.log("[callback] token stored, redirecting to consent");
    const consentUrl = new URL(CONSENT_URL);
    consentUrl.searchParams.set("state", state);

    return Response.redirect(consentUrl.toString(), 302);
  }

  // ── Consent Approval ───────────────────────────────────────────────────────
  // Step 3: the Lovable consent page POSTs here when the user clicks Allow.
  // Body: { state: string }
  // Response: { redirectTo: string } — the consent page does window.location.href
  if (path === "/oauth/approve" && req.method === "POST") {
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch { /* ignore */ }

    const state = (body.state as string) || url.searchParams.get("state") || "";

    if (!state) {
      return jsonError(400, "invalid_request", "missing state");
    }

    console.log("[approve] received state:", state.slice(0, 12));

    const entry = await kv.get<AuthRequest>(["auth", state]);
    if (!entry.value) {
      console.log("[approve] error: state not found in KV");
      return jsonError(400, "invalid_request", "unknown or expired state");
    }
    if (!entry.value.access_token) {
      console.log("[approve] error: no access_token in KV entry — callback may not have run");
      return jsonError(400, "invalid_request", "no token on record — callback step may not have completed");
    }

    const { client_id, redirect_uri, code_challenge, code_challenge_method, access_token } =
      entry.value;

    const code = randomHex(32);

    await kv.set(["code", code], {
      access_token,
      code_challenge,
      code_challenge_method,
      client_id,
      redirect_uri,
      state,
    } as AuthCode, { expireIn: KV_TTL });

    console.log("[approve] stored code in KV:", code, "key: code:", code);

    // One-time use — delete the auth request
    await kv.delete(["auth", state]);

    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set("code", code);
    redirectUrl.searchParams.set("state", state);

    return Response.json({ redirectTo: redirectUrl.toString() }, { headers: corsHeaders });
  }

  // ── Token Endpoint ─────────────────────────────────────────────────────────
  // Step 4: claude.ai exchanges the auth code for an access token.
  // Validates PKCE (S256) before returning the stored Supabase JWT.
  // Accepts both application/json and application/x-www-form-urlencoded bodies.
  if (path === "/oauth/token" && req.method === "POST") {
    console.log("[token] POST /oauth/token", req.headers.get("content-type"));

    let params: Record<string, string> = {};
    const contentType = req.headers.get("content-type") ?? "";

    if (contentType.includes("application/json")) {
      try {
        params = await req.json();
      } catch { /* ignore */ }
    } else {
      const text = await req.text();
      const form = new URLSearchParams(text);
      for (const [k, v] of form.entries()) params[k] = v;
    }

    const { code, code_verifier, grant_type, client_id } = params;
    console.log("[token] grant_type:", grant_type, "code:", code?.slice(0, 16), "has_verifier:", !!code_verifier);

    if (grant_type !== "authorization_code") {
      console.log("[token] error: unsupported_grant_type", grant_type);
      return jsonError(400, "unsupported_grant_type");
    }
    if (!code || !code_verifier) {
      console.log("[token] error: missing code or code_verifier");
      return jsonError(400, "invalid_request", "missing code or code_verifier");
    }

    const codeEntry = await kv.get<AuthCode>(["code", code]);
    if (!codeEntry.value) {
      console.log("[token] error: code not found in KV:", code?.slice(0, 8));
      return jsonError(400, "invalid_grant", "unknown or expired code");
    }

    const { access_token, code_challenge, code_challenge_method } = codeEntry.value;

    if (client_id && codeEntry.value.client_id !== client_id) {
      console.log("[token] error: client_id mismatch", client_id, "vs", codeEntry.value.client_id);
      return jsonError(400, "invalid_client", "client_id mismatch");
    }

    // PKCE S256 validation: SHA-256(code_verifier) === code_challenge
    if (code_challenge_method === "S256") {
      const computed = await sha256Base64Url(code_verifier);
      if (computed !== code_challenge) {
        console.log("[token] error: PKCE mismatch — computed:", computed, "expected:", code_challenge);
        return jsonError(400, "invalid_grant", "PKCE verification failed");
      }
    }

    // One-time use — delete the code
    await kv.delete(["code", code]);

    const tokenResponse = {
      access_token,
      token_type: "bearer",
      expires_in: 3600,
      scope: "openid email",
    };
    console.log("[token] success — returning token, expires_in: 3600, token_prefix:", access_token?.slice(0, 20));

    return Response.json(tokenResponse, { headers: corsHeaders });
  }

  // ── MCP Proxy ──────────────────────────────────────────────────────────────
  // All other requests are forwarded to the Supabase receipts-mcp edge function.
  // The WWW-Authenticate header is rewritten so claude.ai knows to auth via us.
  const headers = new Headers(req.headers);
  headers.delete("host");

  const upstream = await fetch(SUPABASE_MCP, {
    method: req.method,
    headers,
    body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
  });

  const responseHeaders = new Headers(upstream.headers);
  for (const [k, v] of Object.entries(corsHeaders)) {
    responseHeaders.set(k, v);
  }

  if (responseHeaders.has("www-authenticate")) {
    responseHeaders.set("www-authenticate", `Bearer resource_metadata="${MCP_URL}"`);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
});
