import { defineAgent } from "eve";
import { reviewModel } from "../../lib/models";

export default defineAgent({
  description: "Scans the changed lines of a pull request for significant bugs.",
  model: reviewModel(),
  reasoning: "high",
  defaultTools: false,
  tool: false,
});
