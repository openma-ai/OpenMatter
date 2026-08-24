# OpenMatter Brand Foundation

OpenMatter retains the canonical OpenMA family mark and gives the product a
distinct material system: OpenMatter Blue, neutral technical paper, and warm
ink.
The geometry is shared; color and application distinguish the product.

## Story

OpenMatter Blue is inspired by Egyptian Blue, one of the earliest engineered
synthetic pigments. The association is conceptual rather than a claim to
reproduce one physical sample: inputs, proportions, process, and repeatable
transformation produce a durable new material.

Externally, call the color **OpenMatter Blue**. `Egyptian Blue` is design
provenance, not the public color name.

## Canonical assets

| Asset                                                                      | Intended use                                                 |
| -------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [`assets/openmatter-mark.svg`](assets/openmatter-mark.svg)                 | Canonical mark on light or neutral surfaces                  |
| [`assets/openmatter-mark-inverse.svg`](assets/openmatter-mark-inverse.svg) | White mark on OpenMatter Blue or another approved dark solid |
| [`assets/openmatter-favicon.svg`](assets/openmatter-favicon.svg)           | Square favicon and small application icon                    |

Do not redraw, rotate, outline, add gradients, or alter the relative geometry.
The mark uses the original three paths and circular point from the OpenMA
family asset.

## Sources of truth

- [`tokens.json`](tokens.json) is the DTCG-shaped, machine-readable source.
- [`tokens.css`](tokens.css) is the zero-build CSS distribution.
- [`../DESIGN.md`](../DESIGN.md) defines how the tokens compose into UI.
- [`../PRODUCT.md`](../PRODUCT.md) records the product and brand intent.

JSON values use uppercase six-digit sRGB hex. CSS formatters may normalize the
same values to lowercase. Theme-aware application code should consume semantic
tokens such as `color.theme.light.foreground`, never select a ramp value by
appearance alone.

## Color primitives

### OpenMatter Blue

| Token                      | Value     | Intended role                             |
| -------------------------- | --------- | ----------------------------------------- |
| `color.openmatter.blue50`  | `#F1F3FC` | Barely tinted selection surface           |
| `color.openmatter.blue100` | `#DDE4F8` | Selection and quiet highlight             |
| `color.openmatter.blue200` | `#BBC8EC` | Quiet blue boundary; dark-theme focus     |
| `color.openmatter.blue300` | `#91A6DE` | Accessible brand accent on dark surfaces  |
| `color.openmatter.blue400` | `#5876C6` | Focus ring and secondary emphasis         |
| `color.openmatter.blue500` | `#1034A6` | Canonical OpenMatter Blue                 |
| `color.openmatter.blue600` | `#0D2D91` | Light-theme hover                         |
| `color.openmatter.blue700` | `#0A2475` | Light-theme pressed state and strong link |
| `color.openmatter.blue800` | `#071B59` | Deep selected foreground                  |
| `color.openmatter.blue900` | `#05133F` | Dark-theme selected surface               |
| `color.openmatter.blue950` | `#030A24` | Content on dark-theme primary             |

### Technical neutrals

The light ramp stays near neutral rather than cream. Its slight material warmth
comes from the ink and typography, while a restrained cool-gray edge keeps the
blue crisp across long code and documentation pages.

| Token                         | Value     | Intended role                         |
| ----------------------------- | --------- | ------------------------------------- |
| `color.openmatter.neutral0`   | `#FFFFFF` | Raised light surface and inverse mark |
| `color.openmatter.neutral50`  | `#FDFDFB` | Near-neutral technical-paper canvas   |
| `color.openmatter.neutral100` | `#F7F7F6` | Grouped and code surface              |
| `color.openmatter.neutral200` | `#E4E5E7` | Default light boundary                |
| `color.openmatter.neutral300` | `#CECFD1` | Strong light boundary                 |
| `color.openmatter.neutral400` | `#AAA093` | Subtle dark-theme text                |
| `color.openmatter.neutral500` | `#7A7C80` | Nonessential light annotation         |
| `color.openmatter.neutral600` | `#5D5F63` | Accessible muted light text           |
| `color.openmatter.neutral700` | `#49443E` | Default dark boundary                 |
| `color.openmatter.neutral800` | `#302D29` | Raised dark surface                   |
| `color.openmatter.neutral900` | `#201E1B` | Default dark surface                  |
| `color.openmatter.neutral950` | `#11110F` | Warm ink and dark canvas              |

### Semantic status colors

Status colors are deliberately mineral and restrained. They never replace the
brand color and never communicate state without text or an icon.

| Family  | Light surface | Dark emphasis | Light text | Dark surface |
| ------- | ------------- | ------------- | ---------- | ------------ |
| Success | `#ECF7F1`     | `#77C7A2`     | `#166747`  | `#103526`    |
| Warning | `#FFF4D8`     | `#E6B85C`     | `#734600`  | `#3E2900`    |
| Danger  | `#FDEDEA`     | `#E29B93`     | `#9F2D25`  | `#481A18`    |

## Semantic themes

Light and dark themes expose the same 30 roles: canvas and four surface
levels; three foreground levels; two borders; primary, link, focus, and
selection states; code surfaces; and success, warning, and danger pairs. This
keeps components theme-neutral:

```css
.panel {
  color: var(--om-color-foreground);
  background: var(--om-color-surface-raised);
  border: var(--om-border-width-hairline) solid var(--om-color-border);
  border-radius: var(--om-radius-md);
}
```

Use `data-om-theme="dark"` on the root element for the dark mapping. Light is
the default. All text/background pairs used by the semantic themes are tested
to WCAG AA contrast.

## Typography

| Role    | Family                            | Character                              |
| ------- | --------------------------------- | -------------------------------------- |
| Display | Source Serif 4, Georgia, serif    | Editorial materiality for major titles |
| Body    | Geist Variable, system sans-serif | Compact technical prose and controls   |
| Mono    | JetBrains Mono, system monospace  | Code, identifiers, protocol values     |

The size scale runs from `0.75rem` labels to `3.5rem` display type. Use only
400, 500, and 600 weights. Body copy uses a generous `1.65` line height; dense
UI labels do not inherit it.

## Layout, shape, and motion

- Spacing follows a compact 4 px base: `0, 4, 8, 12, 16, 24, 32, 48, 64, 96`.
- Radii are `0, 4, 8, 12, 16px`; `pill` is reserved for tags and truly capsule
  controls, not every container.
- Flat borders and tonal layering establish most hierarchy. `raised` and
  `overlay` are the only shadows.
- State transitions use `120ms`, `180ms`, or `280ms`; spatial movement uses the
  standard or exit easing tokens.
- Reduced-motion preferences set all three duration tokens to `0ms`.
- The z-index scale is named by ownership: base, sticky, dropdown, overlay,
  modal, toast, tooltip.

## Usage constraints

- Keep documentation and product surfaces predominantly neutral. Brand blue
  should generally occupy less than 10% of a screen; its rarity is the point.
- Use `blue500` for the canonical mark on light surfaces and `blue300` for
  accessible brand emphasis on dark surfaces. Do not recolor the logo to a
  semantic status color.
- Use the inverse mark only on a flat field with sufficient contrast.
- Prefer semantic theme aliases in UI code. Primitive ramps are for defining
  aliases, data visualization, and exceptional illustration work.
- OpenMA Coral (`#F84F32`) remains an OpenMA family identifier; it is not an
  OpenMatter fallback or gradient endpoint.
- Do not call these values an exact digital representation of historic
  Egyptian Blue pigment. Physical samples vary with composition and process.
