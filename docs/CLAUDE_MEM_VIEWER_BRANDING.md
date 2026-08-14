# claude-mem Viewer platform branding

This repository carries a small, repeatable UI overlay for the central `claude-mem` Viewer. It replaces plain `platform_source` badges with recognizable product icons while leaving the central Worker, database, HTTP API, capture pipeline, and memory semantics unchanged.

## Scope

The overlay applies to the existing `.card-source source-<platform>` elements used by Prompt, Summary, and Observation cards. It is CSS-only: no React component fork and no database migration are required.

Supported source names and aliases:

| Platform | Source aliases | Artwork source |
| --- | --- | --- |
| ChatGPT | `chatgpt`, `chatgpt-web`, `ChatGPT` | ChatGPT web app favicon (`chatgpt.com`) |
| Codex | `codex`, `codex-cli`, `Codex` | Current Codex app artwork published on OpenAI's Codex get-started page; CSS crops the published icon from that image |
| Claude | `claude`, `claude-code`, `Claude` | Claude web app favicon (`claude.ai`) |
| Pi | `pi`, `Pi` | `pi.dev/logo-auto.svg`, referenced as the Pi logo by the Pi repository README |
| Hermes | `hermes`, `hermes-agent`, `Hermes` | Hermes Agent favicon from `NousResearch/hermes-agent` |
| OpenClaw | `openclaw`, `OpenClaw` | `pixel-lobster.svg` from `openclaw/openclaw` |

Unknown platform sources keep the upstream text-only badge behavior.

## Apply

Run the patcher against the root of the installed or checked-out `claude-mem` tree:

```bash
node deploy/apply-claude-mem-viewer-branding.mjs --root /path/to/claude-mem
```

The script patches whichever of these files exist:

```text
src/ui/viewer-template.html
plugin/ui/viewer.html
```

Patching both is intentional. `src/ui/viewer-template.html` preserves the overlay across Viewer rebuilds, while `plugin/ui/viewer.html` updates the already-built static Viewer immediately.

Verify the installed block without modifying files:

```bash
node deploy/apply-claude-mem-viewer-branding.mjs --root /path/to/claude-mem --check
```

A successful check prints `OK` for each Viewer HTML file found. The patcher is idempotent: applying the current version again leaves already-current files unchanged.

## Deployment and upgrades

After applying the overlay, refresh or hard-refresh the Viewer. A Worker restart is normally unnecessary because the change is confined to static Viewer HTML/CSS. If the deployment layer caches the Viewer HTML, restart or reload that layer using the normal local operating procedure.

Re-run the patcher after every `claude-mem` upgrade. The patch is delimited by these markers so an older overlay is replaced rather than duplicated:

```text
/* central-memory-bridges: platform-source-icons:start */
/* central-memory-bridges: platform-source-icons:end */
```

The patcher prefers the upstream `.card-title` CSS block as its insertion point and falls back to the closing `</style>` tag. It fails instead of silently editing an unknown structure when neither anchor exists.

## Verification checklist

1. Open the central Viewer and hard-refresh it.
2. Confirm recent ChatGPT and Codex Prompt/Summary cards show an icon plus correctly capitalized product name.
3. Confirm Claude, Pi, Hermes, and OpenClaw cards render correctly when those sources are present.
4. Toggle light/dark mode and verify icon alignment and badge readability.
5. Run the patcher with `--check` after upgrades or redeployment.

## Rollback

Restore the two Viewer HTML files from the installed `claude-mem` version, or remove the block between the two `central-memory-bridges: platform-source-icons` markers. No Worker database rollback is required.

## External assets and failure behavior

The overlay deliberately references artwork from product-controlled domains or official project repositories instead of redrawing brand marks. The browser therefore performs ordinary image GET requests for those icons. If an image request is unavailable or blocked, the product text remains visible through the badge pseudo-element.

The Codex icon is currently taken from artwork published on OpenAI's Codex get-started page and cropped with CSS. If OpenAI replaces that source image, the crop may need an update even though the Viewer patch remains functional.

For a fully offline Viewer, vendor reviewed copies of the allowed brand assets into the deployment and change the CSS URLs to local files. Do that only after reviewing the applicable license/trademark terms; do not treat a public asset as an unrestricted software asset by default.

## Brand/trademark note

Product names and logos remain trademarks of their respective owners. This overlay is for source identification in the memory Viewer and must not imply sponsorship or endorsement. For OpenAI marks, follow the current OpenAI brand guidelines: https://openai.com/brand/ .

## Repository source

The implementation is maintained in:

```text
deploy/apply-claude-mem-viewer-branding.mjs
```

Keep deployment-specific secrets, credentials, private hostnames, and runtime tokens out of this repository.
