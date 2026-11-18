# Security policy — development build

This MCP server exposes high-privilege WordPress operations. It is **not security-audited** and should not be used to edit production sites until review and integration testing are complete.

- Access to `/mcp` requires self-hosted OAuth, a valid bearer token and a matching authorization scope.
- Writes additionally require `WPMCP_ALLOW_WRITES=true` and explicit write consent at authorization.
- Use a strong unique `WPMCP_OWNER_PASSWORD`, never reuse WordPress admin credentials.
- Use a unique, strong `WPMCP_REGISTRATION_KEY` and don't share it in videos, logs or screenshots.
- OAuth tokens and WordPress HMAC site credentials are stored in private `data/` files; back up and protect them (file mode 0600).
- The file store is intended for a **single persistent Node process**, not serverless replicas or concurrent workers.
- Use public HTTPS WordPress hosts; the server restricts remote connections to public DNS and HTTPS port 443.
- Restrict who can operate and deploy the MCP server, and periodically rotate credentials.
- Keep site backups and use staging first; code patching can break sites or enable arbitrary code execution in the context of WordPress.
- Report potential vulnerabilities to the maintainer privately. Do not disclose exploitable details in public issues.

Before public release, independently assess OAuth PKCE/DCR behavior, WordPress permissions and authorization scoping, file-patch controls, concurrency, token lifecycle and deployment hardening. Do not present this project as a production-certified OAuth provider.
