# WordPress MCP Server

Standalone WordPress-only MCP service extracted into a new repository for the Jobayer Builds tutorial. The original private MCP remains unchanged.

**Status: DEVELOPMENT / REVIEW REQUIRED. Do not deploy to a production WordPress site yet.**

## Included

31 MCP tools: inspect WordPress, search/read/patch theme and plugin files with revision hashes and rollback; create/read/update content and Rank Math fields; media upload; Elementor document, element and JSON operations; CSS regeneration; URL diagnostics and frontend audits.

**Excluded:** Facebook, YouTube, LinkedIn, Google Analytics, social automation, and other private integrations.

## No Auth0 and no OpenAI API key

The server has a self-hosted OAuth authorization-code + PKCE flow using an owner password, dynamic OAuth client registration and local token storage. The WordPress plugin has independent signed HMAC credentials. Do not confuse this with no authentication: **an owner password and site-registration secret are mandatory.** ChatGPT plan/workspace requirements may apply.

## Test on a staging site

1. Run `npm install`. Node.js 20+ is required.
2. Copy `.env.example` to `.env`, replace **every** example secret with a unique random secret, and configure `MCP_PUBLIC_URL=https://your-mcp-domain`.
3. For local testing with Node 20.6+, run `node --env-file=.env src/server.js`. On Hostinger, set environment variables in the hosting panel and use `npm start`.
4. Deploy over HTTPS using **one persistent Node process** and private persistent storage for `data/`.
5. Confirm `/health` reports `auth_ready: true` and `writes_enabled: false`.
6. Install the matching [wp-mcp-agent](https://github.com/jobayerhossan/wp-mcp-agent) plugin on a test WordPress site. Open **Tools → WordPress MCP Agent**, enter your MCP HTTPS **origin**, site alias and the `WPMCP_REGISTRATION_KEY` configured on the server.
7. When supported by your ChatGPT plan, connect the remote MCP endpoint at `https://your-mcp-domain/mcp` and authorize with `WPMCP_OWNER_PASSWORD`. Writes require enabling `WPMCP_ALLOW_WRITES=true` and actively consenting to write permission in OAuth.

**Safety:** Changes to theme/plugin source can execute code. Back up your site, use staging first, verify revision protection and rollback, and never commit real credentials.

## Hosting limitations

The OAuth and site registries currently use local private JSON storage. They require a single persistent instance; this design is **not yet compatible with stateless Vercel deployments** without a durable shared datastore and additional validation. Hostinger Node hosting is the initial target, but integration/deployment tests are not yet complete.

## Project files

- `src/server.js`: MCP HTTP transport
- `src/tools.js`: WordPress and Elementor MCP tools
- `src/sites.js`: HTTPS HMAC site registration, access and validation
- `src/oauth.js`: self-hosted OAuth with PKCE
- `src/frontend-qa*.js`: frontend inspection/audit
- `SECURITY.md`: security considerations

The original repos are left unchanged. No Elementor Pro or OpenAI API subscription is required by the code itself, but hosting and ChatGPT feature access may have separate requirements.

This code needs a complete security review and end-to-end WordPress/ChatGPT testing before being labeled production-ready or published as a completed tutorial.
