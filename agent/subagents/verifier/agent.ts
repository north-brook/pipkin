import { defineAgent } from "eve";
import { model } from "../../lib/models";

export default defineAgent({
  description: "Scores one candidate code review finding for whether it is a real issue or a false positive.",
  model: model(),
  reasoning: "high",
  defaultTools: false,
  tool: false,
});
