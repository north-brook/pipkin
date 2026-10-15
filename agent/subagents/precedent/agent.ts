import { defineAgent } from "eve";
import { model } from "../../lib/models";

export default defineAgent({
  description: "Checks whether review feedback left on earlier pull requests touching the same files also applies to this one.",
  model: model(),
  reasoning: "high",
  defaultTools: false,
  tool: false,
});
