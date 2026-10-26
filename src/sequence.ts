import type { Tokenizer } from "@huggingface/tokenizers";

export type InternalQuestion = {
  t: "choice";
  ins: string;
  crit: Record<string, string | null>;
};

export function buildSequence(
  tokenizer: Tokenizer,
  special: { cls: number; sep: number; mask: number; pad: number },
  maskToken: string,
  state: string,
  question: InternalQuestion,
  maxLength: number,
  headMaxLength: number,
) {
  const encode = (text: string) =>
    Array.from(
      tokenizer.encode(text.split(maskToken).join(" "), {
        add_special_tokens: false,
      }).ids as ArrayLike<number>,
    );
  const options = Object.entries(question.crit).map(([label, description]) =>
    description == null || description === ""
      ? label
      : `${label}: ${description}`,
  );
  let optionIds = options.map((option) => [
    special.mask,
    ...encode(` ${option}`).slice(0, 48),
  ]);
  let optionBudget =
    headMaxLength - optionIds.reduce((sum, option) => sum + option.length, 0);
  if (optionBudget < 16) {
    const perOption = Math.max(
      4,
      Math.floor((headMaxLength - 16) / optionIds.length),
    );
    optionIds = optionIds.map((option) => option.slice(0, perOption));
    optionBudget =
      headMaxLength - optionIds.reduce((sum, option) => sum + option.length, 0);
  }
  const headerIds = encode(`${question.t} question: ${question.ins}`).slice(
    0,
    Math.max(8, optionBudget),
  );
  const ids = [special.cls, ...headerIds, special.sep];
  const markers: number[] = [];
  for (const option of optionIds) {
    markers.push(ids.length);
    ids.push(...option);
  }
  ids.push(special.sep);
  const textIds = encode(state).slice(
    0,
    Math.max(0, maxLength - ids.length - 1),
  );
  ids.push(...textIds, special.sep);
  return { ids: ids.slice(0, maxLength), markers };
}
