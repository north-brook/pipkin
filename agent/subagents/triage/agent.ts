import { defineAgent } from "eve";
import { triageModel } from "../../lib/models";

export default defineAgent({
  description: "Decides whether a pull request should be reviewed and summarizes the change.",
  model: triageModel(),
  reasoning: "medium",
  defaultTools: false,
  tool: false,
});
