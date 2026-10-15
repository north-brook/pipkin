import { defineAgent } from "eve";
import { model } from "../../lib/models";

export default defineAgent({
  description: "Decides whether a pull request should be reviewed and summarizes the change.",
  model: model(),
  reasoning: "high",
  defaultTools: false,
  tool: false,
});
