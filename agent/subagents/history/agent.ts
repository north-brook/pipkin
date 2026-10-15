import { defineAgent } from "eve";
import { reviewModel } from "../../lib/models";

export default defineAgent({
  description: "Finds bugs in a pull request in light of the git blame and history of the code it modifies.",
  model: reviewModel(),
  reasoning: "high",
  defaultTools: false,
  tool: false,
});
