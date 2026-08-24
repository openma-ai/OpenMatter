import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

const brandFile = (path: string) =>
  new URL(`../brand/${path}`, import.meta.url);

const readBrandFile = (path: string) => readFile(brandFile(path), "utf8");

type TokenValue =
  | string
  | number
  | readonly number[]
  | Readonly<Record<string, string | number>>;

type Token = Readonly<{
  $type: string;
  $value: TokenValue;
  $description: string;
}>;

type TokenNode = Token | TokenGroup;
interface TokenGroup {
  readonly [key: string]: TokenNode;
}

const isToken = (node: TokenNode): node is Token => "$value" in node;

const tokenAt = (tokens: TokenGroup, path: string): Token => {
  let node: TokenNode = tokens;
  for (const segment of path.split(".")) {
    if (isToken(node)) {
      throw new Error(`${path} enters token ${segment}`);
    }
    const child: TokenNode | undefined = node[segment];
    if (child === undefined) {
      throw new Error(`Missing token ${path}`);
    }
    node = child;
  }
  if (!isToken(node)) {
    throw new Error(`${path} is a token group`);
  }
  return node;
};

const colorAt = (tokens: TokenGroup, path: string): string => {
  const value = tokenAt(tokens, path).$value;
  if (typeof value !== "string") {
    throw new Error(`${path} is not a color string`);
  }
  const alias = /^\{(.+)\}$/.exec(value);
  return alias?.[1] === undefined ? value : colorAt(tokens, alias[1]);
};

const relativeLuminance = (hex: string) => {
  const channels = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (channels === null) {
    throw new Error(`Expected six-digit hex, received ${hex}`);
  }
  const linear = channels.slice(1).map((channel) => {
    const value = Number.parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
};

const contrast = (first: string, second: string) => {
  const light = Math.max(relativeLuminance(first), relativeLuminance(second));
  const dark = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (light + 0.05) / (dark + 0.05);
};

const count = (source: string, pattern: RegExp) =>
  Array.from(source.matchAll(pattern)).length;

describe("OpenMatter brand assets", () => {
  test("publishes one machine-readable token source with Egyptian Blue as the canonical primary", async () => {
    const tokens = JSON.parse(await readBrandFile("tokens.json")) as TokenGroup;

    expect(tokenAt(tokens, "color.openmatter.blue500").$value).toBe("#1034A6");
    expect(tokenAt(tokens, "color.role.primary").$value).toBe(
      "{color.openmatter.blue500}",
    );
    expect(tokenAt(tokens, "color.role.onPrimary").$value).toBe(
      "{color.openmatter.white}",
    );
    expect(tokenAt(tokens, "color.role.canvas").$value).toBe(
      "{color.openmatter.paper}",
    );
  });

  test("defines complete Egyptian Blue, technical-neutral, and semantic status ramps", async () => {
    const tokens = JSON.parse(await readBrandFile("tokens.json")) as TokenGroup;

    for (const name of [
      "blue50",
      "blue100",
      "blue200",
      "blue300",
      "blue400",
      "blue500",
      "blue600",
      "blue700",
      "blue800",
      "blue900",
      "blue950",
      "neutral0",
      "neutral50",
      "neutral100",
      "neutral200",
      "neutral300",
      "neutral400",
      "neutral500",
      "neutral600",
      "neutral700",
      "neutral800",
      "neutral900",
      "neutral950",
      "green50",
      "green300",
      "green700",
      "amber50",
      "amber300",
      "amber800",
      "red50",
      "red300",
      "red700",
    ]) {
      expect(tokenAt(tokens, `color.openmatter.${name}`).$type).toBe("color");
    }
    expect(colorAt(tokens, "color.openmatter.paper")).toBe("#FDFDFB");
    expect(colorAt(tokens, "color.openmatter.ink")).toBe("#11110F");
  });

  test("defines the same complete semantic role surface for light and dark themes", async () => {
    const tokens = JSON.parse(await readBrandFile("tokens.json")) as TokenGroup;
    const roles = [
      "canvas",
      "surface",
      "surfaceRaised",
      "surfaceSubtle",
      "surfaceSelected",
      "foreground",
      "foregroundMuted",
      "foregroundSubtle",
      "border",
      "borderStrong",
      "primary",
      "primaryHover",
      "primaryPressed",
      "onPrimary",
      "link",
      "linkHover",
      "focusRing",
      "selection",
      "onSelection",
      "codeSurface",
      "codeBorder",
      "success",
      "successSurface",
      "onSuccessSurface",
      "warning",
      "warningSurface",
      "onWarningSurface",
      "danger",
      "dangerSurface",
      "onDangerSurface",
    ];

    for (const theme of ["light", "dark"]) {
      for (const role of roles) {
        expect(tokenAt(tokens, `color.theme.${theme}.${role}`).$type).toBe(
          "color",
        );
      }
    }
  });

  test("keeps body, muted, primary, link, and status text at WCAG AA contrast", async () => {
    const tokens = JSON.parse(await readBrandFile("tokens.json")) as TokenGroup;
    const pairs = [
      ["light.foreground", "light.canvas"],
      ["light.foregroundMuted", "light.canvas"],
      ["light.onPrimary", "light.primary"],
      ["light.link", "light.canvas"],
      ["light.onSuccessSurface", "light.successSurface"],
      ["light.onWarningSurface", "light.warningSurface"],
      ["light.onDangerSurface", "light.dangerSurface"],
      ["dark.foreground", "dark.canvas"],
      ["dark.foregroundMuted", "dark.canvas"],
      ["dark.onPrimary", "dark.primary"],
      ["dark.link", "dark.canvas"],
      ["dark.onSuccessSurface", "dark.successSurface"],
      ["dark.onWarningSurface", "dark.warningSurface"],
      ["dark.onDangerSurface", "dark.dangerSurface"],
    ] as const;

    for (const [foreground, background] of pairs) {
      expect(
        contrast(
          colorAt(tokens, `color.theme.${foreground}`),
          colorAt(tokens, `color.theme.${background}`),
        ),
        `${foreground} on ${background}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("defines a compact typography, spacing, shape, elevation, motion, and stacking foundation", async () => {
    const tokens = JSON.parse(await readBrandFile("tokens.json")) as TokenGroup;

    for (const path of [
      "fontFamily.display",
      "fontFamily.body",
      "fontFamily.mono",
      "fontSize.xs",
      "fontSize.body",
      "fontSize.display",
      "fontWeight.regular",
      "fontWeight.medium",
      "fontWeight.semibold",
      "lineHeight.tight",
      "lineHeight.body",
      "letterSpacing.tight",
      "letterSpacing.normal",
      "space.0",
      "space.1",
      "space.2",
      "space.3",
      "space.4",
      "space.5",
      "space.6",
      "space.7",
      "space.8",
      "space.9",
      "radius.none",
      "radius.sm",
      "radius.md",
      "radius.lg",
      "radius.xl",
      "radius.pill",
      "borderWidth.hairline",
      "borderWidth.focus",
      "shadow.raised",
      "shadow.overlay",
      "duration.fast",
      "duration.normal",
      "duration.slow",
      "cubicBezier.standard",
      "cubicBezier.out",
      "zIndex.base",
      "zIndex.sticky",
      "zIndex.dropdown",
      "zIndex.overlay",
      "zIndex.modal",
      "zIndex.toast",
      "zIndex.tooltip",
    ]) {
      expect(tokenAt(tokens, path).$description.length, path).toBeGreaterThan(
        0,
      );
    }
  });

  test("publishes CSS aliases that stay aligned with the JSON token values", async () => {
    const [tokensSource, css] = await Promise.all([
      readBrandFile("tokens.json"),
      readBrandFile("tokens.css"),
    ]);
    const tokens = JSON.parse(tokensSource) as TokenGroup;

    const primitives = tokens.color;
    if (primitives === undefined || isToken(primitives)) {
      throw new Error("Missing color token group");
    }
    const openmatter = primitives.openmatter;
    if (openmatter === undefined || isToken(openmatter)) {
      throw new Error("Missing OpenMatter color primitives");
    }
    for (const [name, token] of Object.entries(openmatter)) {
      if (!isToken(token) || typeof token.$value !== "string") {
        continue;
      }
      expect(css.toLowerCase()).toContain(
        `--om-color-${name}: ${token.$value};`.toLowerCase(),
      );
    }
    expect(css).toContain("--om-color-primary: var(--om-color-blue500);");
    expect(css).toContain("--om-color-on-primary: var(--om-color-white);");
    expect(css).toContain(':root[data-om-theme="dark"]');
    expect(css).toContain("--om-font-body:");
    expect(css).toContain("--om-space-4:");
    expect(css).toContain("--om-radius-md:");
    expect(css).toContain("--om-duration-normal:");
  });

  test("keeps the canonical OpenMA geometry in the blue and inverse marks", async () => {
    const [blue, inverse] = await Promise.all([
      readBrandFile("assets/openmatter-mark.svg"),
      readBrandFile("assets/openmatter-mark-inverse.svg"),
    ]);

    for (const mark of [blue, inverse]) {
      expect(mark).toContain('viewBox="240 244 548 454"');
      expect(count(mark, /<path\b/g)).toBe(3);
      expect(count(mark, /<circle\b/g)).toBe(1);
    }
    expect(blue).toContain('fill="#1034A6"');
    expect(inverse).toContain('fill="#FFFFFF"');
  });

  test("publishes a square favicon with a blue field and white canonical mark", async () => {
    const favicon = await readBrandFile("assets/openmatter-favicon.svg");

    expect(favicon).toContain('viewBox="0 0 64 64"');
    expect(favicon).toContain('fill="#1034A6"');
    expect(favicon).toContain('fill="#FFFFFF"');
    expect(count(favicon, /<path\b/g)).toBe(3);
    expect(count(favicon, /<circle\b/g)).toBe(1);
  });
});
