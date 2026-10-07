# dsh design tokens (reference)

Extracted from the locally installed `@deepseek-ai/dsh-client-ui-theme` (DeepSeek Harness,
**MIT License**). Kept here as provenance for `acp/src/web/index.html`, which re-maps its
palette variables onto these tokens.

- `palette.css` — raw palette (`--dsw-static-*`): neutrals, blues, DeepSeek brand, states
- `alias.css` — semantic layer (`--dsw-alias-*`); light value first, dark value second

Fonts (`acp/src/web/fonts/`) are **Montserrat** under the SIL Open Font License —
the license text ships alongside them (`Montserrat-OFL.txt`).

What we copied verbatim: token values, radii scale, the half-pixel elevation stroke,
shadows, font files. What we did NOT copy: React/Cordis component code — those modules
depend on the entire DeepSeek Harness runtime (200+ packages), so reusing them would mean
shipping dsh itself rather than a control plane. Our UI stays a zero-dependency page that
renders with the same design language.
