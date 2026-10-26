import fs from "node:fs";
import { Tokenizer } from "@huggingface/tokenizers";
import { buildSequence } from "../src/sequence.ts";

const modelDirectory = process.argv[2];
const fixturePath =
  process.argv[3] ?? new URL("./sequence-fixtures.json", import.meta.url);
if (!modelDirectory) {
  throw new Error(
    "Usage: node --experimental-strip-types tests/sequence-parity.mjs <model-dir> [fixtures.json]",
  );
}
const tokenizer = new Tokenizer(
  JSON.parse(fs.readFileSync(`${modelDirectory}/tokenizer.json`, "utf8")),
  JSON.parse(
    fs.readFileSync(`${modelDirectory}/tokenizer_config.json`, "utf8"),
  ),
);
const tokenizerJson = JSON.parse(
  fs.readFileSync(`${modelDirectory}/tokenizer.json`, "utf8"),
);
const tokenizerConfig = JSON.parse(
  fs.readFileSync(`${modelDirectory}/tokenizer_config.json`, "utf8"),
);
const config = JSON.parse(
  fs.readFileSync(`${modelDirectory}/rl_agent_config.json`, "utf8"),
);
const specialId = (key) => {
  const value = tokenizerConfig[key];
  const token = typeof value === "string" ? value : value.content;
  return tokenizerJson.added_tokens.find((entry) => entry.content === token).id;
};
const pyDumps = (value) => {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number")
    return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(pyDumps).join(", ")}]`;
  return `{${Object.entries(value)
    .map(([key, item]) => `${JSON.stringify(key)}: ${pyDumps(item)}`)
    .join(", ")}}`;
};
const special = {
  cls: specialId("cls_token"),
  sep: specialId("sep_token"),
  mask: specialId("mask_token"),
  pad: specialId("pad_token"),
};
const fixtures = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
let mismatches = 0;
for (const [index, fixture] of fixtures.entries()) {
  const criteria = Array.isArray(fixture.question.criteria)
    ? Object.fromEntries(
        fixture.question.criteria.map((label) => [label, null]),
      )
    : fixture.question.criteria;
  const internal = {
    t: fixture.question.type,
    ins: fixture.question.instructions,
    crit: criteria,
  };
  const actual = buildSequence(
    tokenizer,
    special,
    typeof tokenizerConfig.mask_token === "string"
      ? tokenizerConfig.mask_token
      : tokenizerConfig.mask_token.content,
    typeof fixture.state === "string" ? fixture.state : pyDumps(fixture.state),
    internal,
    config.max_len,
    config.head_max_len,
  );
  const expected = { ids: fixture.ids, markers: fixture.markers };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    mismatches += 1;
    console.error(`Sequence mismatch in multilingual case ${index}`);
    console.error(`Expected ${JSON.stringify(expected).slice(0, 400)}`);
    console.error(`Actual   ${JSON.stringify(actual).slice(0, 400)}`);
  }
}
console.log(
  `${fixtures.length - mismatches}/${fixtures.length} multilingual token sequences match Python`,
);
process.exitCode = mismatches ? 1 : 0;
