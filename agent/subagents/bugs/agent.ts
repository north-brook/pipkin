import { defineAgent } from "eve";
import { model } from "../../lib/models";

export default defineAgent({
  description: "Scans the changed lines of a pull request for significant bugs.",
  model: model(),
  reasoning: "high",
  defaultTools: false,
  tool: false,
});
