# claude-mem Viewer platform branding

This repository carries a small, repeatable UI overlay for the central `claude-mem` Viewer. It replaces plain `platform_source` badges with recognizable product icons while leaving the central Worker, database, HTTP API, capture pipeline, and memory semantics unchanged.

## Scope

The overlay applies to the existing `.card-source source-<platform>` elements used by Prompt, Summary, and Observation cards. It is CSS-only: no React component fork and no database migration are required.

Supported source names and aliases:

| Platform | Source aliases | Artwork source |
| --- | --- | --- |
| ChatGPT | `chatgpt`, `chatgpt-web`, `ChatGPT` | OpenAI's current Blossom symbol; OpenAI-authored SVG transported through Wikimedia Commons because anonymous cross-site requests to `chatgpt.com`/`openai.com` favicon endpoints are Cloudflare-challenged |
| Codex | `codex`, `codex-cli`, `Codex` | Current Codex app artwork published on OpenAI's Codex get-started page; CSS crops the published icon from that image |
| Claude | `claude`, `claude-code`, `Claude` | Claude web app favicon (`claude.ai`) |
| Pi | `pi`, `Pi` | `pi.dev/logo-auto.svg`, referenced as the Pi logo by the Pi repository README |
| Hermes | `hermes`, `hermes-agent`, `Hermes` | Hermes Agent favicon from `NousResearch/hermes-agent` |
| OpenClaw | `openclaw`, `OpenClaw` | `pixel-lobster.svg` from `openclaw/openclaw` |

Unknown platform sources keep the upstream text-only badge behavior.

## Apply

Run the patcher against the root of an installed, checked-out, marketplace, or cache copy of `claude-mem`:

```bash
node deploy/apply-claude-mem-viewer-branding.mjs --root /path/to/claude-mem
```

The script patches whichever of these files exist:

```text
src/ui/viewer-template.html
plugin/ui/viewer.html
ui/viewer.html
```

`src/ui/viewer-template.html` preserves the overlay across Viewer rebuilds, `plugin/ui/viewer.html` updates a marketplace/installed Viewer, and `ui/viewer.html` supports versioned plugin cache roots.

Verify the installed block without modifying files:

```bash
node deploy/apply-claude-mem-viewer-branding.mjs --root /path/to/claude-mem --check
```

A successful check prints `OK` for each Viewer HTML file found. The patcher is idempotent: applying the current version again leaves already-current files unchanged.

## Deployment and upgrades

After applying the overlay, verify the HTML actually served by the Worker rather than assuming the on-disk change is live. `claude-mem` 13.15.0 in the production deployment was observed to cache Viewer HTML at Worker startup: the on-disk file contained the new branding block while the live HTTP response still returned the previous HTML until the Worker was restarted.

Recommended sequence:

```bash
node deploy/apply-claude-mem-viewer-branding.mjs --root /path/to/claude-mem
node deploy/apply-claude-mem-viewer-branding.mjs --root /path/to/claude-mem --check
# Verify the live Viewer response contains the marker below.
# Restart/reload the Worker only if the live response is still stale.
```

Re-run the patcher after every `claude-mem` upgrade. The patch is delimited by these markers so an older overlay is replaced rather than duplicated:

```text
/* central-memory-bridges: platform-source-icons:start */
/* central-memory-bridges: platform-source-icons:end */
```

The patcher prefers the upstream `.card-title` CSS block as its insertion point and falls back to the closing `</style>` tag. It fails instead of silently editing an unknown structure when neither anchor exists.

Production also wires the patcher into the existing non-blocking weekly `claude-mem` update flow after the source/platform identity overlay. Marketplace and versioned cache Viewer copies are reapplied after an official upgrade; branding failure is logged but does not abort the official upgrade/rollback path.

## Verification checklist

1. Run the patcher with `--check` for the marketplace/installed root and any active cache roots.
2. Fetch the live Viewer HTML and confirm it contains `central-memory-bridges: platform-source-icons:start`; restart/reload the Worker if the live response remains stale.
3. Open the central Viewer and hard-refresh it.
4. Confirm recent ChatGPT and Codex Prompt/Summary cards show an icon plus correctly capitalized product name.
5. Confirm Claude, Pi, Hermes, and OpenClaw cards render correctly when those sources are present.
6. Toggle light/dark mode and verify icon alignment and badge readability.
7. Confirm the icon asset URLs remain reachable. Text labels remain visible if an image cannot be loaded.

## Production validation — 2026-08-14

The overlay was deployed to the central `claude-mem` 13.15.0 Worker on 2026-08-14. Validation confirmed:

- marketplace and active versioned cache Viewer HTML were patched and passed `--check`;
- the live Worker initially served cached pre-patch HTML, then served both the existing platform-identity marker and the new icon-branding marker after a controlled Worker restart;
- Worker health returned `status=ok`, version `13.15.0`, with MCP ready after restart;
- the ChatGPT MCP bridge remained active, and Hermes dashboard/gateway services remained active;
- Claude, Codex, Pi, Hermes, and OpenClaw artwork endpoints returned HTTP 200 from the deployment host;
- the direct ChatGPT/OpenAI favicon endpoints returned HTTP 403 to anonymous requests, so the ChatGPT badge was changed to the OpenAI-authored Blossom SVG via the Wikimedia Commons redirect, which returned HTTP 200.

## Rollback

Restore the Viewer HTML files from the installed `claude-mem` version or deployment backup, or remove the block between the two `central-memory-bridges: platform-source-icons` markers. If the Worker caches Viewer HTML, restart/reload it after rollback. No Worker database rollback is required.

## External assets and failure behavior

The overlay references product/project artwork rather than redrawing brand marks. The browser therefore performs ordinary image GET requests for those icons. If an image request is unavailable or blocked, the product text remains visible through the badge pseudo-element.

For ChatGPT, the graphic is OpenAI's current Blossom symbol. The asset is OpenAI-authored, while Wikimedia Commons is used as the transport mirror because the OpenAI/ChatGPT web favicon endpoints are protected against anonymous cross-site requests. The Codex icon is taken from artwork published on OpenAI's Codex get-started page and cropped with CSS; if OpenAI replaces that source image, the crop may need an update even though the Viewer patch remains functional.

For a fully offline Viewer, vendor reviewed copies of the allowed brand assets into the deployment and change the CSS URLs to local files. Do that only after reviewing the applicable license/trademark terms; do not treat a public asset as an unrestricted software asset by default.

## Brand/trademark note

Product names and logos remain trademarks of their respective owners. This overlay is for source identification in the memory Viewer and must not imply sponsorship or endorsement. OpenAI's current brand guidance says its marks should be used only when directly related to OpenAI services, exactly as provided, without implying endorsement. See https://openai.com/brand/ .

## Repository source

The implementation is maintained in:

```text
deploy/apply-claude-mem-viewer-branding.mjs
```

Keep deployment-specific secrets, credentials, private hostnames, and runtime tokens out of this repository.
