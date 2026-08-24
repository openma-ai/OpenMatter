# OpenMatter documentation

The documentation site for OpenMatter: the open-source, deployment-neutral work
layer for agents.

It documents the executable v0 foundation: Work Integrations, Context
Projection and grants, Agent Drivers, Session/Turn continuity, durable Reactions
and Effects, Slack, credentials, and deployment shapes.

## Development

Requires Node.js `>=22.13.0`.

```bash
npm install
npm run dev
```

Use `npm run build` for a production build, `npm test` for rendered-route smoke
tests, and `npm run deploy` to publish the static Worker to Cloudflare.

## Content structure

- `astro.config.mjs` — Starlight navigation, search, metadata, and `/doc` base
- `src/content/docs/` — MDX documentation pages
- `src/styles/custom.css` — the small OpenMA-family theme overlay
- `wrangler.jsonc` — static Cloudflare deployment for `matter.openma.dev`

The site deliberately uses the same Astro + Starlight documentation system as
OpenMA instead of maintaining a bespoke React documentation shell.
