import { defineAgent } from "eve";
import { model } from "../../lib/models";

export default defineAgent({
  description: "Checks a pull request diff against the repository's rules files (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, coding standards) and the smell baseline.",
  model: model(),
  reasoning: "high",
  defaultTools: false,
  tool: false,
});
