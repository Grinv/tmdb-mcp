import { test } from "node:test";
import assert from "node:assert/strict";
import { detailPerson, summarizeFind, type TmdbPerson } from "../format.js";

// Direct unit tests for shaping edge cases that are cheap to hit without any
// HTTP/MCP scaffolding, and that the tool-level tests don't happen to exercise.

test("detailPerson maps every TMDB gender code, including unknown ones, to a safe label", () => {
  const person = (gender: number | undefined): TmdbPerson => ({ id: 1, name: "X", gender });
  assert.equal(detailPerson(person(1)).gender, "female");
  assert.equal(detailPerson(person(2)).gender, "male");
  assert.equal(detailPerson(person(3)).gender, "non-binary");
  assert.equal(detailPerson(person(0)).gender, null); // 0 = "not specified" upstream
  assert.equal(detailPerson(person(undefined)).gender, null);
});

test("summarizeFind maps person_results, not just movie/tv", () => {
  const s = summarizeFind({
    movie_results: [],
    tv_results: [],
    person_results: [{ id: 6193, name: "Leonardo DiCaprio", known_for_department: "Acting" }],
  });
  const persons = s.person_results as { id: number; media_type: string; name: string }[];
  assert.equal(persons[0]!.id, 6193);
  assert.equal(persons[0]!.media_type, "person");
  assert.equal(persons[0]!.name, "Leonardo DiCaprio");
});
