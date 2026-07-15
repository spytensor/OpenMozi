# MOZI DESIGN.md — Binding Design Standard

> Adapted from the **Impeccable** methodology (github.com/pbakaus/impeccable, Apache-2.0):
> the anti-pattern discipline is vendored as *authored rules*, not as external code.
> This file is the single source of truth for MOZI's visual design — for **both**
> MOZI's own web UI (`ui/`) **and** the visual artifacts MOZI generates for users
> (HTML pages, decks, documents). If a design choice conflicts with this file,
> this file wins; change this file first.

## North Star

MOZI is a **personal Agent OS** — a calm, dense, professional operator surface, not a
consumer toy and not a generic "AI tool". The interface should feel **quiet, charcoal-dark,
and utilitarian**: information-dense without clutter, confident without decoration. The
product proof (chat, task runtime, artifacts, code) must always stay legible; the visual
system never competes with it.

## Design Tokens (source of truth: `ui/src/index.css`)

Never hardcode colors/radii in components — consume these variables.

**Dark theme (default) — neutral charcoal, never pure black**
- Grounds: `--app-bg #181818`, `--main-bg #181818`, `--sidebar-bg #151515`
- Surfaces (elevation by background shift, not shadow): `--surface-base #181818` → `--surface-elevated #202020` → `--surface-input #20252c` → `--surface-hover #272d35` → `--surface-active #303741`
- Real overlays only: `--surface-overlay #202020dd` (Dialog/Popover); the light theme resolves it to opaque white
- Accent: `--accent #3a8dff` (dark) / `#5457d6` (light); soft fill `--accent-soft`; glow `--accent-glow` (subtle, indicator-only)
- Status: `--success #7acb8b` · `--warning #e3b65a` · `--danger #e06c75` (danger = errors only, sparingly)
- Text (opacity layers on ink, not separate grays): primary .9 / secondary .7 / muted .46 / disabled .25
- Borders (hairline-first): `--border-subtle` (rgba .06) default, `--border-medium` (.1) active
- Radii (compact, sharply bounded): `--radius-card 8px` · `--radius-button 6px` · `--radius-badge 4px`
- Shadows: only the composer setback shadows; cards use border + background shift, **not** drop shadows

## Binding Rules (MOZI already respects most — keep it that way)

**DO**
- Consume tokens; add a new token to `index.css` rather than a one-off hex in a component.
- Elevate surfaces with background shift + a hairline border first; add shadow only when truly needed.
- Keep cards compact, flat, sharply bounded (8px), single-level — no card-in-card.
- Keep motion purposeful and short (fades, small translates, ≤200ms); ease-out, standard curves.
- Preserve legibility of product proof: chat, tables, code, task/artifact cards stay readable above all styling.
- Respect both `dark` (default) and `light` themes via tokens.

**DO NOT (hard red lines — these are what "AI slop" looks like)**
- **No emoji in the UI.** (Pre-existing MOZI red line — absolute.)
- No purple→blue / neon gradients, no neon cyan fields, no glow as decoration.
- No glassmorphism / decorative `backdrop-blur` (translucency is allowed *only* for real overlays: modals, menus).
- No bounce/elastic/overshoot easing (`cubic-bezier` with values >1); no gratuitous motion.
- No pure black or pure white as a fill or ground — always tint toward the warm palette.
- No gray body text on colored backgrounds; use the ink-opacity text layers.
- No card-in-card nesting; no oversized rounded "pill" cards for dense content.
- No default/undistinctive typographic hierarchy — respect the size/weight scale, don't ship walls of same-size text.

## Known Deviations (tracked — fix deliberately, don't regress further)

These exist today; new code must not add more, and prefer the target when touching them:
1. **`--accent-fg: #ffffff` is pure white.** Target: tint (e.g. `#faf9f7`). Low urgency.
2. **All colors are hex; 0 OKLCH.** Impeccable prefers OKLCH for perceptual consistency. Migration is a nicety, not a blocker — new *brand* colors may be authored in OKLCH; do not mass-rewrite existing tokens without a design pass.
3. **Body font is `Inter, system-ui, …`** — flagged as "overused". A distinctive display face is a deliberate future brand decision; until then Inter stays (documented, not accidental). Do not silently switch fonts.
4. **3 `backdrop-blur` usages.** Audit each: keep only where it backs a real overlay; remove decorative blur.

## Applies To MOZI-Generated Artifacts Too

When MOZI generates an HTML page, deck, or document for a user, it must follow the same
DO/DO-NOT rules above (enforced at runtime via the `design-impeccable` skill). Uploaded/
generated deliverables are "product proof" — legible, restrained, no AI-slop tells.
