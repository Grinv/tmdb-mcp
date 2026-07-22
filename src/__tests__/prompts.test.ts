import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { connectServer, contentText } from "./helpers.js";

describe("recommend_similar prompt", () => {
  test("is advertised via prompts/list", async (t) => {
    const { client, close } = await connectServer({});
    t.after(close);
    const { prompts } = await client.listPrompts();
    const p = prompts.find((p) => p.name === "recommend_similar");
    assert.ok(p, "recommend_similar should be listed");
    assert.ok(p!.arguments?.some((a) => a.name === "title" && a.required));
  });

  test("builds a plan message naming the title and default count", async (t) => {
    const { client, close } = await connectServer({});
    t.after(close);
    const res = await client.getPrompt({
      name: "recommend_similar",
      arguments: { title: "The Man from Earth" },
    });
    assert.equal(res.messages.length, 1);
    const msg = res.messages[0]!;
    assert.equal(msg.role, "user");
    const text = contentText(msg.content);
    assert.match(text, /The Man from Earth/);
    assert.match(text, /Recommend 5/);
    assert.match(text, /search_multi/);
    assert.match(text, /get_similar/);
  });

  test("honors media_type and a custom count", async (t) => {
    const { client, close } = await connectServer({});
    t.after(close);
    const res = await client.getPrompt({
      name: "recommend_similar",
      arguments: { title: "Forrest Gump", media_type: "movie", count: "3" },
    });
    const text = contentText(res.messages[0]!.content);
    assert.match(text, /Forrest Gump.*\(a movie\)/);
    assert.match(text, /Recommend 3/);
  });

  test("rejects a non-numeric count via the argument schema", async (t) => {
    const { client, close } = await connectServer({});
    t.after(close);
    await assert.rejects(() =>
      client.getPrompt({
        name: "recommend_similar",
        arguments: { title: "Dune", count: "many" },
      }),
    );
  });
});

describe("top_by_entity prompt", () => {
  test("is advertised via prompts/list", async (t) => {
    const { client, close } = await connectServer({});
    t.after(close);
    const { prompts } = await client.listPrompts();
    const p = prompts.find((p) => p.name === "top_by_entity");
    assert.ok(p, "top_by_entity should be listed");
    assert.ok(p!.arguments?.some((a) => a.name === "name" && a.required));
  });

  test("builds a plan message naming the entity and default count", async (t) => {
    const { client, close } = await connectServer({});
    t.after(close);
    const res = await client.getPrompt({
      name: "top_by_entity",
      arguments: { name: "A24" },
    });
    assert.equal(res.messages.length, 1);
    const msg = res.messages[0]!;
    assert.equal(msg.role, "user");
    const text = contentText(msg.content);
    assert.match(text, /A24/);
    assert.match(text, /top 5/);
    assert.match(text, /search_people/);
    assert.match(text, /search_companies/);
    assert.match(text, /discover_movies/);
    assert.match(text, /get_person_credits/);
  });

  test("honors entity_type, genre, media_type and a custom count", async (t) => {
    const { client, close } = await connectServer({});
    t.after(close);
    const res = await client.getPrompt({
      name: "top_by_entity",
      arguments: {
        name: "Quentin Tarantino",
        entity_type: "person",
        genre: "Crime",
        media_type: "movie",
        count: "3",
      },
    });
    const text = contentText(res.messages[0]!.content);
    assert.match(text, /Quentin Tarantino.*\(a person\).*Crime/);
    assert.match(text, /top 3/);
    assert.match(text, /movie only/);
    assert.match(text, /discover_movies/);
    // media_type=movie must drop the TV-only branch, not just say "movie only"
    // in the intro while still instructing the model through TV steps too.
    assert.doesNotMatch(text, /For TV/);
    assert.doesNotMatch(text, /discover_tv/);
  });

  test("media_type=tv drops the movies-only branch", async (t) => {
    const { client, close } = await connectServer({});
    t.after(close);
    const res = await client.getPrompt({
      name: "top_by_entity",
      arguments: { name: "Shonda Rhimes", media_type: "tv" },
    });
    const text = contentText(res.messages[0]!.content);
    assert.match(text, /tv only/);
    assert.match(text, /discover_tv/);
    assert.doesNotMatch(text, /For movies/);
    assert.doesNotMatch(text, /discover_movies/);
  });

  test("rejects a non-numeric count via the argument schema", async (t) => {
    const { client, close } = await connectServer({});
    t.after(close);
    await assert.rejects(() =>
      client.getPrompt({
        name: "top_by_entity",
        arguments: { name: "Studio Ghibli", count: "many" },
      }),
    );
  });
});
