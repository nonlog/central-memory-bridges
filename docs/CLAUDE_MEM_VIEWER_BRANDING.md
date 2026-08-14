# claude-mem Viewer platform branding

This repository carries a small, repeatable UI overlay for the central `claude-mem` Viewer. It replaces plain `platform_source` badges with recognizable product icons while leaving the central Worker, database, HTTP API, capture pipeline, and memory semantics unchanged.

## Scope

The overlay applies to the existing `.card-source source-<platform>` elements used by Prompt, Summary, and Observation cards. It is CSS-only: no React component fork and no database migration are required.

Supported source names and aliases:

| Platform | Source aliases | Artwork source |
| --- | --- | --- |
| ChatGPT | `chatgpt`, `chatgpt-web`, `ChatGPT` | OpenAI's current Blossom symbol; OpenAI-authored SVG transported through Wikimedia Commons because anonymous cross-site requests to `chatgpt.com`/`openai.com` favicon endpoints are Cloudflare-challenged |
| Codex | `codex`, `codex-cli`, `Codex` | Preferred: the official `codex-app-ga-logo--UgmJjKM.png` bundled with the OpenAI Codex app/extension, installed locally beside `viewer.html` as `codex-app-ga-logo.png`; fallback: OpenAI Blossom |
| Claude | `claude`, `claude-code`, `Claude` | Claude web app favicon (`claude.ai`) |
| Pi | `pi`, `Pi` | `pi.dev/logo-auto.svg`, referenced as the Pi logo by the Pi repository README |
| Hermes | `hermes`, `hermes-agent`, `Hermes` | Hermes Agent favicon from `NousResearch/hermes-agent` |
| OpenClaw | `openclaw`, `OpenClaw` | Current official animated mascot/favicon from the installed OpenClaw Control UI, copied locally beside `viewer.html` as `openclaw-favicon.svg` |

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

## Codex asset

The Codex badge no longer crops a large promotional image. That approach produced a visibly malformed tiny blue/purple fragment at badge size.

For the production deployment, the icon was taken from the installed official OpenAI Codex package/extension asset named `codex-app-ga-logo--UgmJjKM.png` (104×104 RGBA, SHA-256 `8e82b26c98a10e45798ce48124515720657f7735fb8d0853b3f087eaa8a6b74e`). A reviewed copy is stored outside the public source repository and copied beside each active `viewer.html` as:

```text
codex-app-ga-logo.png
```

The CSS tries that relative local asset first and uses the OpenAI Blossom as a clean fallback if the local Codex asset is absent. This keeps the public repository from redistributing a product binary asset while allowing deployments that already possess the official Codex package to use its real app logo.

## OpenClaw asset

The initial OpenClaw badge used `docs/assets/pixel-lobster.svg`. That file is an official repository asset, but it is not the current rounded red mascot shown by the OpenClaw website and Control UI, so the Viewer badge did not visually match the product.

Production now uses the current `favicon.svg` shipped with the installed OpenClaw Control UI:

```text
/usr/lib/node_modules/openclaw/dist/control-ui/favicon.svg
```

That SVG contains the current red mascot and its declarative animation. A copy is stored outside the public source repository and installed beside every active Viewer HTML as:

```text
openclaw-favicon.svg
```

The branding CSS references that local filename directly. If the file is missing, the OpenClaw text label still remains visible; deployment should treat a missing mascot asset as a warning and restore it from the installed OpenClaw package or the reviewed persistent copy.

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

Production also wires the patcher into the existing non-blocking weekly `claude-mem` update flow after the source/platform identity overlay. Marketplace and versioned cache Viewer copies are reapplied after an official upgrade; the local Codex and OpenClaw assets are copied into those Viewer directories before branding is applied. Branding failure is logged but does not abort the official upgrade/rollback path.

## Verification checklist

1. Run the patcher with `--check` for the marketplace/installed root and any active cache roots.
2. Fetch the live Viewer HTML and confirm it contains `central-memory-bridges: platform-source-icons:start`; restart/reload the Worker if the live response remains stale.
3. Confirm `codex-app-ga-logo.png` returns HTTP 200 in deployments using the official local Codex asset.
4. Confirm `openclaw-favicon.svg` returns HTTP 200 and, when sourced from a local OpenClaw install, matches the installed Control UI favicon hash.
5. Open the central Viewer and hard-refresh it.
6. Confirm recent ChatGPT, Codex, and OpenClaw Prompt/Summary/Observation cards show the expected icon plus correctly capitalized product name.
7. Confirm Claude, Pi, and Hermes cards render correctly when those sources are present.
8. Toggle light/dark mode and verify icon alignment and badge readability.

## Production validation — 2026-08-14

The overlay was deployed to the central `claude-mem` 13.15.0 Worker on 2026-08-14. Validation confirmed:

- marketplace and active versioned cache Viewer HTML were patched and passed `--check`;
- the live Worker initially served cached pre-patch HTML, then served both the existing platform-identity marker and the new icon-branding marker after a controlled Worker restart;
- Worker health returned `status=ok`, version `13.15.0`, with MCP ready after restart;
- the ChatGPT MCP bridge remained active, and Hermes dashboard/gateway services remained active;
- the direct ChatGPT/OpenAI favicon endpoints returned HTTP 403 to anonymous requests, so the ChatGPT badge uses the OpenAI-authored Blossom SVG via the Wikimedia Commons redirect;
- the first Codex implementation cropped an OpenAI promotional image and rendered incorrectly at badge size; it was replaced with the 104×104 `codex-app-ga-logo` asset extracted from the installed official OpenAI Codex package;
- after the Codex fix, the local `codex-app-ga-logo.png` endpoint returned HTTP 200 and the live Viewer HTML referenced it directly;
- the first OpenClaw implementation used the repository `pixel-lobster.svg`, which did not match the current rounded mascot shown by OpenClaw's website/Control UI;
- the OpenClaw badge was switched to the installed Control UI `favicon.svg`, copied locally as `openclaw-favicon.svg`; the live endpoint returned HTTP 200, its SHA-256 exactly matched the installed OpenClaw source asset, and the live Viewer HTML referenced the local filename.

## Rollback

Restore the Viewer HTML files from the installed `claude-mem` version or deployment backup, or remove the block between the two `central-memory-bridges: platform-source-icons` markers. If the Worker caches Viewer HTML, restart/reload it after rollback. No Worker database rollback is required.

## External assets and failure behavior

The overlay references product/project artwork rather than redrawing brand marks. If an image request is unavailable or blocked, the product text remains visible through the badge pseudo-element.

For ChatGPT, the graphic is OpenAI's current Blossom symbol. The asset is OpenAI-authored, while Wikimedia Commons is used as the transport mirror because the OpenAI/ChatGPT web favicon endpoints are protected against anonymous cross-site requests. For Codex, production prefers a local copy of the official app asset already present in an installed OpenAI Codex package; the public patcher falls back to the Blossom when that file is unavailable. For OpenClaw, production uses a local copy of the official Control UI favicon already present in the installed OpenClaw package.

For a fully offline Viewer, vendor reviewed copies of the allowed brand assets into the deployment and change the CSS URLs to local files. Do that only after reviewing the applicable license/trademark terms; do not treat a public asset as an unrestricted software asset by default.

## Brand/trademark note

Product names and logos remain trademarks of their respective owners. This overlay is for source identification in the memory Viewer and must not imply sponsorship or endorsement. OpenAI's current brand guidance says its marks should be used only when directly related to OpenAI services, exactly as provided, without implying endorsement. See https://openai.com/brand/ .

## Repository source

The implementation is maintained in:

```text
deploy/apply-claude-mem-viewer-branding.mjs
```

Keep deployment-specific secrets, credentials, private hostnames, and runtime tokens out of this repository.
