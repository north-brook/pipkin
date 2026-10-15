import { defineAgent } from "eve";
import { model } from "../../lib/models";

export default defineAgent({
  description: "Checks that a pull request's changes comply with guidance in code comments in the modified files.",
  model: model(),
  reasoning: "high",
  defaultTools: false,
  tool: false,
});
