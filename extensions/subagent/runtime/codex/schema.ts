import { Type } from "typebox";

/** Model-facing Codex task schema; execution semantics stay in its parser. */
export function codexReviewTargetSchema() {
  const text = () => Type.String({ minLength: 1, pattern: "\\S" });
  return Type.Optional(
    Type.Union(
      [
        Type.Object(
          { type: Type.Literal("uncommittedChanges") },
          { additionalProperties: false },
        ),
        Type.Object(
          { type: Type.Literal("baseBranch"), branch: text() },
          { additionalProperties: false },
        ),
        Type.Object(
          {
            type: Type.Literal("commit"),
            sha: text(),
            title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          },
          { additionalProperties: false },
        ),
        Type.Object(
          { type: Type.Literal("custom"), instructions: text() },
          { additionalProperties: false },
        ),
      ],
      {
        description:
          "Codex-only native review target. Required for agents with runtime_args: review. Omit prompt for structured targets; use custom instructions for tailored review requests. Supply a new target on each resume.",
      },
    ),
  );
}
