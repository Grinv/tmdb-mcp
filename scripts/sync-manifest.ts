// Generate manifest.json's prompt `text` (the .mcpb's static copy of each
// prompt) from what the server itself renders, so src/prompts.ts stays the
// only place a plan is written. Each required argument is left as mcpb's
// `${arguments.KEY}` placeholder for the host to fill; optional ones take
// their defaults. version.test.ts fails when the manifest is stale — run
// `npm run sync:manifest`. Uses targeted replacement, not JSON
// re-serialization, to keep the file's formatting (see sync-version.ts).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { createLogger } from "../src/lib/logger.ts";

const root = join(import.meta.dirname, "..");

/** Each prompt's name → its text as the server renders it for the manifest. */
export async function renderManifestPrompts(): Promise<Map<string, string>> {
  const server = buildServer(loadConfig({}), createLogger("silent"));
  const client = new Client({ name: "sync-manifest", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const texts = new Map<string, string>();
    for (const prompt of (await client.listPrompts()).prompts) {
      const required = (prompt.arguments ?? []).filter((a) => a.required).map((a) => a.name);
      const res = await client.getPrompt({
        name: prompt.name,
        arguments: Object.fromEntries(required.map((a) => [a, `\${arguments.${a}}`])),
      });
      const content = res.messages[0]?.content;
      if (content?.type !== "text") throw new Error(`${prompt.name} rendered no text message`);
      texts.set(prompt.name, content.text);
    }
    return texts;
  } finally {
    await client.close();
    await server.close();
  }
}

async function main(): Promise<void> {
  const file = join(root, "manifest.json");
  let manifest = readFileSync(file, "utf8");
  for (const [name, text] of await renderManifestPrompts()) {
    // The prompt's own "text" field: the first one after its "name".
    const field = new RegExp(
      `("name": ${JSON.stringify(name)},[\\s\\S]*?"text": )"(?:[^"\\\\]|\\\\.)*"`,
    );
    if (!field.test(manifest)) {
      throw new Error(`sync-manifest: no "text" for prompt ${name} in manifest.json — add one`);
    }
    manifest = manifest.replace(field, (_m, head: string) => head + JSON.stringify(text));
  }
  writeFileSync(file, manifest);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
