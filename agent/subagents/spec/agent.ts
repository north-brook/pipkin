import { defineAgent } from "eve";
import { reviewModel } from "../../lib/models";

export default defineAgent({
  description: "Checks whether a pull request implements what its originating issue or spec asked for.",
  model: reviewModel(),
  reasoning: "high",
  defaultTools: false,
  tool: false,
});
