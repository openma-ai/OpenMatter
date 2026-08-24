---
name: OpenMatter
description: The durable Agent Loop framework for work systems.
colors:
  blue-50: "#F1F3FC"
  blue-100: "#DDE4F8"
  blue-200: "#BBC8EC"
  blue-300: "#91A6DE"
  blue-400: "#5876C6"
  openmatter-blue: "#1034A6"
  blue-600: "#0D2D91"
  blue-700: "#0A2475"
  blue-800: "#071B59"
  blue-900: "#05133F"
  blue-950: "#030A24"
  pure-white: "#FFFFFF"
  warm-paper: "#FDFDFB"
  warm-surface: "#F7F7F6"
  warm-border: "#E4E5E7"
  warm-border-strong: "#CECFD1"
  dark-muted-subtle: "#AAA093"
  warm-muted-subtle: "#7A7C80"
  warm-muted: "#5D5F63"
  dark-border: "#49443E"
  dark-raised: "#302D29"
  dark-surface: "#201E1B"
  warm-ink: "#11110F"
  success-surface: "#ECF7F1"
  success-dark-emphasis: "#77C7A2"
  success: "#166747"
  success-dark-surface: "#103526"
  warning-surface: "#FFF4D8"
  warning-dark-emphasis: "#E6B85C"
  warning: "#734600"
  warning-dark-surface: "#3E2900"
  danger-surface: "#FDEDEA"
  danger-dark-emphasis: "#E29B93"
  danger: "#9F2D25"
  danger-dark-surface: "#481A18"
typography:
  display:
    fontFamily: "Source Serif 4, Georgia, serif"
    fontSize: "3.5rem"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "Source Serif 4, Georgia, serif"
    fontSize: "2.25rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Geist Variable, -apple-system, Segoe UI, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.25
  body:
    fontFamily: "Geist Variable, -apple-system, Segoe UI, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: "Geist Variable, -apple-system, Segoe UI, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.25
    letterSpacing: "0.01em"
  mono:
    fontFamily: "JetBrains Mono, SFMono-Regular, Consolas, monospace"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.55
rounded:
  none: "0"
  sm: "4px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  pill: "9999px"
spacing:
  1: "4px"
  2: "8px"
  3: "12px"
  4: "16px"
  5: "24px"
  6: "32px"
  7: "48px"
  8: "64px"
  9: "96px"
components:
  button-primary:
    backgroundColor: "{colors.openmatter-blue}"
    textColor: "{colors.pure-white}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "12px 16px"
  button-primary-hover:
    backgroundColor: "{colors.blue-600}"
    textColor: "{colors.pure-white}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "12px 16px"
  button-quiet:
    backgroundColor: "{colors.warm-surface}"
    textColor: "{colors.warm-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "12px 16px"
  field:
    backgroundColor: "{colors.pure-white}"
    textColor: "{colors.warm-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "12px 16px"
  surface:
    backgroundColor: "{colors.pure-white}"
    textColor: "{colors.warm-ink}"
    rounded: "{rounded.md}"
    padding: "24px"
  navigation-active:
    backgroundColor: "{colors.blue-50}"
    textColor: "{colors.blue-700}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
---

# Design System: OpenMatter

## Overview

**Creative North Star: “The Engineered Pigment”**

OpenMatter should feel like a precise technical manual printed with one
remarkable pigment. The blue gives the system identity; warm paper, disciplined
type, and exact spacing do the work of making dense information readable. The
result is material and quietly opinionated, never ornamental.

The system makes boundaries visible: work-platform facts, authorized context,
Agent reasoning, durable state, and effects should remain easy to distinguish.
It explicitly rejects generic AI SaaS gradients, glowing glass panels,
interchangeable rounded cards, and decoration that competes with code or
architecture.

**Key characteristics:**

- one rare, saturated brand voice;
- warm-neutral, documentation-first surfaces;
- editorial display type paired with technical sans and mono;
- compact 4 px spacing and restrained corner radii;
- semantic color, shallow elevation, and short motion.

## Colors

OpenMatter Blue is an engineered-pigment blue rather than an electric SaaS
blue. It is paired with near-neutral technical paper. Warmth comes from ink,
type, and spacing rather than a yellow canvas.

### Primary

- **OpenMatter Blue** (`#1034A6`): the canonical mark, primary action, links,
  focus relationships, and the strongest structural emphasis on light
  surfaces.
- **Blue Mineral Light** (`#91A6DE`): the accessible expression of the brand on
  dark surfaces.

### Neutral

- **Technical Paper** (`#FDFDFB`): default light canvas for long-form reading.
- **Quiet Surface** (`#F7F7F6`): grouped content, code fields, and quiet control
  backgrounds.
- **Neutral Boundary** (`#E4E5E7`): default divider and control border.
- **Warm Ink** (`#11110F`): primary light-theme text and dark canvas.
- **Dark Surface** (`#201E1B`): default dark-theme surface; it remains warm
  rather than blue-black.

### Semantic state

- **Verdigris Success** (`#166747`): successful state, paired with `#ECF7F1`.
- **Ochre Warning** (`#734600`): caution state, paired with `#FFF4D8`.
- **Iron-Oxide Danger** (`#9F2D25`): destructive or failed state, paired with
  `#FDEDEA`.

**The One Pigment Rule.** OpenMatter Blue should generally occupy less than 10%
of a screen. Its rarity is the point. Status colors never become brand colors,
and color never communicates state without text or an icon.

## Typography

**Display Font:** Source Serif 4 (with Georgia fallback)
**Body Font:** Geist Variable (with system sans-serif fallback)
**Label/Mono Font:** Geist Variable / JetBrains Mono

**Character:** Source Serif gives major ideas editorial weight without turning
the product into a magazine. Geist and JetBrains Mono keep controls, prose,
identifiers, and code precise.

### Hierarchy

- **Display** (600, `3.5rem`, `1.1`): rare landing-page statements and major
  document openings.
- **Headline** (600, `2.25rem`, `1.25`): page-level documentation headings.
- **Title** (600, `1.5rem`, `1.25`): panel and section titles.
- **Body** (400, `1rem`, `1.65`): prose, ideally constrained to 72 characters
  per line.
- **Label** (500, `0.875rem`, `0.01em`): controls, metadata, and navigation;
  sentence case by default.
- **Mono** (400, `0.875rem`, `1.55`): code, protocol values, resource IDs, and
  durable state.

**The Two-Voice Rule.** Serif describes the system; sans-serif operates it.
Do not apply display type to controls or monospace to ordinary prose.

## Elevation

The system is flat by default. Tonal surface changes and one-pixel warm borders
create structure; shadows only distinguish content that actually rises above
the document plane.

### Shadow vocabulary

- **Raised** (`0 2px 6px rgb(17 17 15 / 12%)`): menus and compact floating
  controls.
- **Overlay** (`0 12px 32px -8px rgb(17 17 15 / 22%)`): dialogs and transient
  overlays only.

**The Honest Elevation Rule.** If a surface does not overlap another surface,
it does not need a shadow. Hover should not make every card levitate.

## Components

Components are restrained and legible. Their distinctiveness comes from
proportion, type, and states rather than bespoke decoration.

### Buttons

- **Shape:** medium radius (`8px`), with `12px 16px` default padding.
- **Primary:** OpenMatter Blue background and white label; only one primary
  action should dominate a local region.
- **Hover / Focus:** hover deepens to `#0D2D91`; keyboard focus uses a 2 px
  `#5876C6` ring with visible separation from the control.
- **Quiet:** warm-surface background, warm-ink label, and a one-pixel boundary.

### Chips

- **Style:** use pill radius only when the control is semantically a compact
  tag, filter, or status capsule.
- **State:** selected chips use the blue-50 surface and blue-700 text; include a
  text label or icon for semantic states.

### Cards / Containers

- **Corner style:** `8px` by default; `12px` for large independent surfaces.
- **Background:** white raised surface on warm paper, or tonal warm surface for
  grouped content.
- **Shadow strategy:** flat and bordered by default; use Raised only when the
  surface overlaps nearby content.
- **Internal padding:** `24px` default, `16px` for dense panels.

### Inputs / Fields

- **Style:** white surface, one-pixel warm border, `8px` radius, body type.
- **Focus:** preserve the border and add the 2 px blue focus ring.
- **Error / Disabled:** use semantic danger with text for errors; use muted
  foreground and a quiet surface for disabled controls.

### Navigation

Use medium-weight sans-serif labels. Default navigation remains neutral;
hover uses blue text, and active items use a blue-50 field with blue-700 text.
Do not turn the whole navigation rail into a brand-blue slab.

## Do's and Don'ts

### Do:

- **Do** use semantic theme variables so light and dark themes keep the same
  hierarchy and component contract.
- **Do** keep OpenMatter Blue (`#1034A6`) rare and intentional, generally below
  10% of the visible surface.
- **Do** use the warm-neutral ramp for dense documentation, code, diagrams, and
  operational UI.
- **Do** make work context, Agent reasoning, credentials, and durable state
  visually distinguishable.
- **Do** keep visible bot identity, AgentProfile behavior, and ExecutionIdentity
  permissions distinct.
- **Do** preserve WCAG 2.2 AA contrast, keyboard focus, reduced motion, and a
  non-color state cue.

### Don't:

- **Don't** use generic AI SaaS electric gradients, glowing purple-blue
  surfaces, glass panels, or interchangeable rounded cards.
- **Don't** replace the palette with corporate status green or default Tailwind
  blue, or spray the accent across every interactive surface.
- **Don't** over-personify an Agent or collapse a visible bot, a work profile,
  and an execution identity into one concept.
- **Don't** apply fashion-editorial styling as decoration to technical
  documentation.
- **Don't** invent a separate neon or purple dark-theme palette; preserve the
  same OpenMatter identity and hierarchy.
- **Don't** make one runtime, platform, cloud, or control plane look mandatory.
- **Don't** use pill radii for ordinary cards, fields, panels, and buttons.
- **Don't** redraw, rotate, outline, gradient-fill, or change the geometry of
  the OpenMA family mark.
