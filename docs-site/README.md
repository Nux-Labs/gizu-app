# Gizu Docs

User-facing documentation for Gizu, built with [Docusaurus](https://docusaurus.io/). Engineering documentation lives in [`../docs`](../docs/README.md).

```sh
npm ci          # or: just docs-install
npm start       # dev server on http://localhost:3000 (just docs-start)
npm run build   # static site in ./build (just docs-build)
```

Pages are in `docs/`, the sidebar in `sidebars.ts` and the Gizu theme in `src/css/custom.css`. The docs are served from the site root (`routeBasePath: '/'`).

Before the first deploy, set `url` in `docusaurus.config.ts` to the final docs domain.
