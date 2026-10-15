import { defineAgent } from "eve";
import { reviewModel } from "../../lib/models";

export default defineAgent({
  description: "Checks a pull request diff against the repository's rules files (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, coding standards) and the smell baseline.",
  model: reviewModel(),
  reasoning: "high",
  defaultTools: false,
  tool: false,
});
