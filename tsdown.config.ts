import { defineConfig } from "tsdown";

// Produces a single self-contained ESM bundle at dist/index.js with all
// dependencies inlined, so the .mcpb bundle (and npx) need no node_modules.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
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
  // No sourcemap: this is a distributed executable server, not a debugged
  // library; the .mcpb excludes .map anyway, and it keeps the npm tarball lean.
  sourcemap: false,
  clean: true,
  // No .d.ts: this is an executable MCP server, not a consumed library.
  dts: false,
  // Minify to shrink the shipped bundle (npm + .mcpb). We log err.message, not
  // raw stack traces, so readability of our diagnostics is unaffected.
  minify: true,
  banner: { js: "#!/usr/bin/env node" },
  // platform "node" defaults to .mjs; keep dist/index.js so manifest
  // entry_point and bin resolve.
  fixedExtension: false,
});
