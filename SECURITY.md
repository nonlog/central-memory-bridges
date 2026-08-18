# Security policy

This repository contains integration code, not credentials.

Do not commit production tokens, passwords, private keys, `.env` files, htpasswd content, Cloudflare tunnel credentials, OAuth runtime access/refresh tokens, dynamically registered client state, or conversation exports containing secrets.

If a credential is pasted into a chat, terminal, issue, or commit, treat it as exposed and rotate/revoke it rather than adding it to this repository.

## Destructive central-memory administration

`claude_mem_forget` is intentionally narrow. It accepts exact `observation`, `summary`, or `prompt` IDs only and delegates deletion to the official `claude-mem` Worker DELETE routes.

Do not extend this layer with fuzzy deletion, project-wide wipes, arbitrary SQL, filesystem access, or shell execution. Agents should identify records through the normal memory search/recent/timeline surfaces before deletion.

Prefer loopback Worker access for same-host OpenClaw deployments. When remote Worker authentication is required, keep bearer tokens in environment/secret storage and never commit them to this repository.
