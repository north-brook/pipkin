import { defineAgent } from "eve";
import { model } from "../../lib/models";

export default defineAgent({
  description: "Checks whether a pull request implements what its originating issue or spec asked for.",
  model: model(),
  reasoning: "high",
  defaultTools: false,
  tool: false,
});
