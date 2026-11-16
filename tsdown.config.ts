import { defineConfig } from "tsdown";

// Produces a single self-contained ESM bundle at dist/index.js with all
// dependencies inlined, so the .mcpb bundle (and npx) need no node_modules.
// Relies on tsdown's defaults for the rest — entry src/index.ts, ESM, node
// platform, dist/, clean, no sourcemap — and on its target, which it derives
// from package.json engines.node, so the Node floor lives in one place.
export default defineConfig({
  // tsdown leaves anything in `dependencies` external by default — which would
  // make dist/index.js require node_modules at runtime and break the .mcpb
  // (it ships none). Force every runtime dep inline so the bundle is truly
  // self-contained. Keep this list in sync with package.json "dependencies".
  deps: {
    alwaysBundle: [/^@modelcontextprotocol\/server($|\/)/, /^zod($|\/)/],
    // And nothing else: the build fails if any other node_modules package
    // (e.g. a new transitive dep) would be inlined, so it can't slip into the
    // shipped bundle unreviewed. @modelcontextprotocol/core comes with server.
    onlyBundle: ["@modelcontextprotocol/server", "@modelcontextprotocol/core", "zod"],
  },
  // No .d.ts: this is an executable MCP server, not a consumed library. Set
  // explicitly because tsdown infers it from package.json/tsconfig.
  dts: false,
  // Minify to shrink the shipped bundle (npm + .mcpb). We log err.message, not
  // raw stack traces, so readability of our diagnostics is unaffected.
  minify: true,
  banner: { js: "#!/usr/bin/env node" },
  // platform "node" defaults to .mjs; keep dist/index.js so manifest
  // entry_point and bin resolve.
  fixedExtension: false,
  // A bundler warning (circular import, eval, …) fails the build instead of
  // scrolling past.
  failOnWarn: true,
  // Lint package.json/files for npm-publishing mistakes (bin, files, …). CI
  // only: it reads the packed tarball, too slow to pay on every local build.
  publint: "ci-only",
});
