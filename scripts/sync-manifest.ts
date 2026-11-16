// Generate manifest.json's prompts (the .mcpb's static copy of each prompt:
// description, arguments, text) from what the server itself registers and
// renders, so src/prompts.ts stays the only place a prompt is written. mcpb's
// static text only substitutes `${arguments.KEY}` — no optional arguments,
// defaults or branches — so the template carries the required arguments as
// placeholders and declares just those; optional ones take their defaults
// here and stay available through the server's own prompts/list. version.test.ts
// fails when the manifest is stale — run `npm run sync:manifest`. Uses targeted
// replacement, not JSON re-serialization, to keep the file's formatting.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { createLogger } from "../src/lib/logger.ts";

const root = join(import.meta.dirname, "..");

export interface ManifestPrompt {
  description: string;
  arguments: string[];
  text: string;
}

/** Each prompt's name → its manifest entry, as the server registers/renders it. */
export async function renderManifestPrompts(): Promise<Map<string, ManifestPrompt>> {
  const server = buildServer(loadConfig({}), createLogger("silent"));
  const client = new Client({ name: "sync-manifest", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const prompts = new Map<string, ManifestPrompt>();
    for (const prompt of (await client.listPrompts()).prompts) {
      const required = (prompt.arguments ?? []).filter((a) => a.required).map((a) => a.name);
      const res = await client.getPrompt({
        name: prompt.name,
        arguments: Object.fromEntries(required.map((a) => [a, `\${arguments.${a}}`])),
      });
      const content = res.messages[0]?.content;
      if (content?.type !== "text") throw new Error(`${prompt.name} rendered no text message`);
      prompts.set(prompt.name, {
        description: prompt.description ?? "",
        arguments: required,
        text: content.text,
      });
    }
    return prompts;
  } finally {
    await client.close();
    await server.close();
  }
}

async function main(): Promise<void> {
  const file = join(root, "manifest.json");
  let manifest = readFileSync(file, "utf8");
  for (const [name, entry] of await renderManifestPrompts()) {
    for (const [field, value] of Object.entries(entry)) {
      // This prompt's own field: the first one after its "name". The value is
      // a JSON string or a one-line array.
      const pattern = new RegExp(
        `("name": ${JSON.stringify(name)},[\\s\\S]*?"${field}": )(?:"(?:[^"\\\\]|\\\\.)*"|\\[[^\\]]*\\])`,
      );
      if (!pattern.test(manifest)) {
        throw new Error(
          `sync-manifest: no "${field}" for prompt ${name} in manifest.json — add one`,
        );
      }
      manifest = manifest.replace(pattern, (_m, head: string) => head + JSON.stringify(value));
    }
  }
  writeFileSync(file, manifest);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
