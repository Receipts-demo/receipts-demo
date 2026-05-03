# Receipts MCP Server

**GitHub for non-coders.** Receipts captures the thinking, decisions and proof of work behind what non-technical people build with AI. Voice note in, timestamped AI-structured claim out.

Live app: [receipts.tools](https://receipts.tools)  
MCP server: `https://mcp.receipts.tools`

---

## What this repo contains

This repo (`Receipts-demo/receipts-demo`) holds the backend for Receipts:

- `supabase/functions/` - Supabase Edge Functions (Deno)
  - `receipts-mcp/` - the hosted MCP server (9 tools, OAuth 2.1)
  - `process-entry/` - Claude Haiku claim generation
  - `assess-ai-level/` - AI Native level assessment
  - `transcribe-audio/` - ElevenLabs STT proxy
  - `text-to-speech/` - ElevenLabs TTS proxy
  - `generate-shipped-card/` - shipped build card generation
  - `create-workspace/` - workspace creation
  - `join-workspace/` - workspace invite flow
- `mcp-proxy/` - Deno Deploy OAuth 2.1 proxy at `mcp.receipts.tools`
- `supabase/migrations/` - Postgres schema migrations

The React frontend lives at [Receipts-demo/get-receipts](https://github.com/Receipts-demo/get-receipts).

---

## Connecting to Claude

The Receipts MCP server is hosted and requires no installation.

### Option 1 - Claude.ai connector (OAuth)

1. Go to **Settings > Connectors** in claude.ai
2. Add a custom connector with URL: `https://mcp.receipts.tools`
3. Sign in or create a Receipts account when prompted
4. Done - all 9 tools are available in your Claude conversations

### Option 2 - Personal API token (power users)

Copy your JWT from your Receipts profile page and use it as a Bearer token in any MCP-compatible client:

```
Authorization: Bearer <your-token>
```

---

## MCP Tools

All tools require authentication. The caller's identity is resolved from the Bearer JWT on every request.

| Tool | Description |
|------|-------------|
| `log_entry(text, project_id?)` | Log a build entry. Claude generates a structured claim automatically. Optionally assign to a project. |
| `get_my_builds()` | List your projects with status and entry count. |
| `create_build(name, goal, status?)` | Create a new build. Default status is "In Progress". |
| `update_build_status(project_id, status)` | Update a project's status (e.g. "Shipped", "Dropped"). |
| `get_entries(project_id)` | Fetch your entries for a project, ordered by date. Returns claim, entry type, timestamp and raw transcript. |
| `get_shipped_card(project_id)` | Fetch the public shipped card for any project. Returns goal, key wins, one-line learning and tools used. |
| `search_builds(query)` | Search your builds by name or tools used. |
| `copy_build(project_id)` | Get a structured "copy this build" prompt for any shipped project. Teammates can copy colleagues' builds. |
| `add_idea(text)` | Save an idea directly to your ideas board. |

### Example usage in Claude

```
Log this for me: Today I built an automated email classifier using Claude and Zapier. 
Took 3 hours, works on 90% of cases. Saved to the "Email Automation" project.
```

```
What builds do I have in progress?
```

```
Ship the "Email Automation" project and show me the card.
```

---

## Architecture

```
claude.ai
   |
   | OAuth 2.1 (PKCE)
   v
mcp.receipts.tools          <- Deno Deploy proxy (mcp-proxy/main.ts)
   |  - OAuth 2.1 server (register, authorize, token, approve)
   |  - Proxies MCP traffic to Supabase
   |
   v
Supabase Edge Function      <- receipts-mcp/index.ts
   |  - MCP Streamable HTTP (JSON-RPC 2.0)
   |  - 9 tools
   |  - JWT auth via supabase.auth.getUser()
   |
   v
Supabase Postgres           <- Central EU
   - entries, projects, ideas, profiles, workspaces
```

**OAuth flow:**
1. claude.ai redirects user to `mcp.receipts.tools/oauth/authorize`
2. Proxy redirects to `receipts.tools/login` with PKCE state
3. User signs in; login page redirects back to proxy with Supabase JWT
4. Proxy generates AES-GCM encrypted auth code (no cross-instance KV dependency)
5. claude.ai exchanges code for token; Supabase JWT used as Bearer on all MCP calls

---

## Tech stack

- **MCP transport:** Streamable HTTP (JSON-RPC 2.0 over POST)
- **Auth:** OAuth 2.1 with PKCE + dynamic client registration
- **Proxy runtime:** Deno Deploy
- **Backend:** Supabase (Postgres + Edge Functions, Deno)
- **AI:** Claude Haiku (`claude-haiku-4-5-20251001`) for claim generation
- **Voice:** ElevenLabs scribe_v2 (STT) + eleven_multilingual_v2 (TTS)
- **Frontend:** React/TypeScript on Lovable

---

## Data model (key tables)

```sql
entries      -- build log entries, each with raw_transcript + AI-generated claim
projects     -- builds, with key_wins / tools_used / shipped card fields
profiles     -- AI Native level (1-5), display name, workspace
ideas        -- quick ideas board
workspaces   -- team collaboration spaces
```

---

## Self-hosting

The edge functions can be deployed to any Supabase project. The OAuth proxy is a single Deno Deploy entrypoint at `mcp-proxy/main.ts`.

Required environment variables for the proxy:

```
SUPABASE_ANON_KEY   - used to validate Supabase JWTs
CODE_SECRET         - 32+ char random string for AES-GCM auth code encryption
```

---

## Links

- App: [receipts.tools](https://receipts.tools)
- MCP server: `https://mcp.receipts.tools`
- Frontend repo: [Receipts-demo/get-receipts](https://github.com/Receipts-demo/get-receipts)
