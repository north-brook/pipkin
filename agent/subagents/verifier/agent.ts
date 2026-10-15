import { defineAgent } from "eve";
import { triageModel } from "../../lib/models";

export default defineAgent({
  description: "Scores one candidate code review finding for whether it is a real issue or a false positive.",
  model: triageModel(),
  reasoning: "medium",
  defaultTools: false,
  tool: false,
});
