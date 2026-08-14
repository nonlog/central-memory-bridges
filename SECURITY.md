# Security policy

This repository contains integration code, not credentials.

Do not commit production tokens, passwords, private keys, `.env` files, htpasswd content, Cloudflare tunnel credentials, OAuth runtime access/refresh tokens, dynamically registered client state, or conversation exports containing secrets.

If a credential is pasted into a chat, terminal, issue, or commit, treat it as exposed and rotate/revoke it rather than adding it to this repository.
