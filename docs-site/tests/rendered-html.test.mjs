import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function builtPage(relativePath) {
  return readFile(
    new URL(`../dist/doc/${relativePath}`, import.meta.url),
    "utf8",
  );
}

async function builtStyles(relativePath) {
  const html = await builtPage(relativePath);
  const hrefs = Array.from(html.matchAll(/href="([^\"]+\.css)"/g), (match) =>
    match[1].replace(/^\/doc\//, ""),
  );
  return Promise.all(hrefs.map((href) => builtPage(href))).then((styles) =>
    styles.join("\n"),
  );
}

test("defines the OpenMatter brand mapping at the source boundary", async () => {
  const css = await readFile(
    new URL("../src/styles/custom.css", import.meta.url),
    "utf8",
  );
  const favicon = await readFile(
    new URL("../public/favicon.svg", import.meta.url),
    "utf8",
  );

  assert.match(css, /--sl-color-accent:\s*#91a6de/i);
  assert.match(css, /--sl-color-accent:\s*#1034a6/i);
  assert.match(css, /--sl-color-bg-accent:\s*#91a6de/i);
  assert.match(css, /--sl-color-bg-accent:\s*#1034a6/i);
  assert.match(
    css,
    /\.hero\s+\.sl-link-button\.primary[^}]+background:\s*var\(--sl-color-bg-accent\)/is,
  );
  assert.match(css, /--sl-color-black:\s*#fdfdfb/i);
  assert.match(css, /--sl-color-gray-7:\s*#f7f7f6/i);
  assert.doesNotMatch(
    css,
    /--sl-color-(?:black|gray-7):\s*#(?:fbfaf6|f4f1ea)/i,
  );
  assert.match(css, /--sl-color-white:\s*#11110f/i);
  assert.doesNotMatch(css, /#(?:f84f32|ff6b50|e0512f|ffd9d0|5a1a0a)/i);
  assert.match(favicon, /#1034a6/i);
  assert.doesNotMatch(favicon, /#f84f32/i);
});

test("builds the OpenMatter Starlight home under /doc", async () => {
  const html = await builtPage("index.html");
  assert.match(
    html,
    /<title>OpenMatter — Durable agent loops for work systems<\/title>/i,
  );
  assert.match(html, /durable Agent Loop framework/i);
  assert.match(html, /href="\/doc\/quickstart\/"/i);
  assert.match(html, /<site-search/i);
  assert.match(html, /data-theme=/i);
  assert.doesNotMatch(html, /class="(?:flow-grid|principle|next-grid)"/i);
});

test("builds independently titled MDX reference pages", async () => {
  for (const [relativePath, title, phrase] of [
    ["quickstart/index.html", "Quickstart", "Accept one work event"],
    ["integrations/slack/index.html", "Slack", "Signed HTTP"],
  ]) {
    const html = await builtPage(relativePath);
    assert.match(html, new RegExp(`<title>${title}[^<]*OpenMatter`, "i"));
    assert.match(html, new RegExp(phrase, "i"));
    assert.match(
      html,
      /href="https:\/\/github\.com\/openma-ai\/OpenMatter\/edit\//i,
    );
  }
});

test("emits the OpenMatter blue and neutral-paper design tokens without OpenMA Coral", async () => {
  const css = await builtStyles("quickstart/index.html");

  assert.match(css, /--sl-color-accent:\s*#91a6de/i);
  assert.match(css, /--sl-color-accent-low:\s*#05133f/i);
  assert.match(css, /--sl-color-accent-high:\s*#f1f3fc/i);
  assert.match(css, /--sl-color-accent:\s*#1034a6/i);
  assert.match(css, /--sl-color-accent-low:\s*#dde4f8/i);
  assert.match(css, /--sl-color-accent-high:\s*#071b59/i);
  assert.match(css, /--sl-color-black:\s*#fdfdfb/i);
  assert.match(css, /--sl-color-gray-7:\s*#f7f7f6/i);
  assert.doesNotMatch(
    css,
    /--sl-color-(?:black|gray-7):\s*#(?:fbfaf6|f4f1ea)/i,
  );
  assert.match(css, /--sl-color-white:\s*#11110f/i);
  assert.doesNotMatch(css, /#(?:f84f32|ff6b50|e0512f|ffd9d0|5a1a0a)/i);

  const favicon = await readFile(
    new URL("../public/favicon.svg", import.meta.url),
    "utf8",
  );
  assert.match(favicon, /#1034a6/i);
  assert.doesNotMatch(favicon, /#f84f32/i);
});

test("publishes the neutral light ramp consistently in the brand distributions", async () => {
  const tokens = JSON.parse(
    await readFile(new URL("../../brand/tokens.json", import.meta.url), "utf8"),
  );
  const css = await readFile(
    new URL("../../brand/tokens.css", import.meta.url),
    "utf8",
  );

  assert.equal(tokens.color.openmatter.neutral50.$value, "#FDFDFB");
  assert.equal(tokens.color.openmatter.neutral100.$value, "#F7F7F6");
  assert.equal(tokens.color.openmatter.neutral200.$value, "#E4E5E7");
  assert.equal(tokens.color.openmatter.neutral300.$value, "#CECFD1");
  assert.equal(tokens.color.openmatter.neutral500.$value, "#7A7C80");
  assert.equal(tokens.color.openmatter.neutral600.$value, "#5D5F63");
  assert.equal(tokens.color.openmatter.paper.$value, "#FDFDFB");

  assert.match(css, /--om-color-neutral50:\s*#fdfdfb/i);
  assert.match(css, /--om-color-neutral100:\s*#f7f7f6/i);
  assert.match(css, /--om-color-neutral200:\s*#e4e5e7/i);
  assert.match(css, /--om-color-neutral300:\s*#cecfd1/i);
  assert.match(css, /--om-color-neutral500:\s*#7a7c80/i);
  assert.match(css, /--om-color-neutral600:\s*#5d5f63/i);
  assert.match(css, /--om-color-paper:\s*#fdfdfb/i);
});

test("publishes the built-in Claude Tag orchestration as a complete example", async () => {
  const quickstart = await builtPage("quickstart/index.html");
  const example = await builtPage("orchestration/claude-tag/index.html");

  assert.match(quickstart, /href="\/doc\/orchestration\/claude-tag\/"/i);
  assert.match(example, /<title>Claude Tag Loop[^<]*OpenMatter/i);
  assert.match(example, /app\.loop/i);
  assert.match(example, /claudeTag/i);
  assert.match(example, /makeSlackIntegration/i);
  assert.match(example, /createOpenMatter/i);
  assert.match(example, /commandVisibility/i);
  assert.match(example, /Scope and WorkThread/i);
});

test("documents built-in and user-defined Loops as the primary composition unit", async () => {
  const html = await builtPage("concepts/loops/index.html");

  assert.match(html, /<title>Loops[^<]*OpenMatter/i);
  assert.match(html, /defineLoop/i);
  assert.match(html, /app\.loop/i);
  assert.match(html, /built-in Loop/i);
  assert.match(html, /terminal Reaction/i);
});
