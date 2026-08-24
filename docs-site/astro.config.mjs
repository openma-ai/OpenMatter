import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import starlight from "@astrojs/starlight";

const FONT_HREF =
  "https://fonts.googleapis.com/css2?family=Source+Serif+4:wght@500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap";

export default defineConfig({
  site: "https://matter.openma.dev",
  base: "/doc",
  outDir: "./dist/doc",
  integrations: [
    starlight({
      title: "OpenMatter",
      description: "The storage- and deployment-neutral work layer for agents.",
      favicon: "/doc/favicon.svg",
      logo: {
        light: "./src/assets/openmatter-mark.svg",
        dark: "./src/assets/openmatter-mark-inverse.svg",
        alt: "OpenMatter",
      },
      customCss: ["./src/styles/custom.css"],
      head: [
        {
          tag: "link",
          attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" },
        },
        {
          tag: "link",
          attrs: {
            rel: "preconnect",
            href: "https://fonts.gstatic.com",
            crossorigin: "",
          },
        },
        {
          tag: "link",
          attrs: {
            rel: "stylesheet",
            href: FONT_HREF,
            media: "print",
            onload: "this.media='all'",
          },
        },
        {
          tag: "noscript",
          content: `<link rel="stylesheet" href="${FONT_HREF}">`,
        },
      ],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/openma-ai/OpenMatter",
        },
      ],
      editLink: {
        baseUrl: "https://github.com/openma-ai/OpenMatter/edit/main/docs-site/",
      },
      lastUpdated: true,
      pagination: true,
      sidebar: [
        {
          label: "Get Started",
          items: [
            { label: "Welcome", link: "/doc/" },
            { label: "Quickstart", slug: "quickstart" },
            { label: "Architecture", slug: "architecture" },
          ],
        },
        {
          label: "Concepts",
          items: [
            { label: "Loops", slug: "concepts/loops" },
            { label: "Domain model", slug: "concepts/domain-model" },
            { label: "Runtime lifecycle", slug: "concepts/runtime" },
          ],
        },
        {
          label: "Build",
          items: [
            { label: "Work integrations", slug: "integrations/overview" },
            { label: "Slack", slug: "integrations/slack" },
            { label: "GitHub", slug: "integrations/github" },
            { label: "Linear", slug: "integrations/linear" },
            { label: "Agent drivers", slug: "agents/drivers" },
            {
              label: "Claude Tag orchestration",
              slug: "orchestration/claude-tag",
            },
          ],
        },
        {
          label: "Operate",
          items: [
            { label: "Deployment", slug: "operate/deployment" },
            { label: "Credentials", slug: "operate/credentials" },
          ],
        },
      ],
    }),
    mdx(),
  ],
});
