import { defineAgent } from "eve";
import { model } from "../../lib/models";

export default defineAgent({
  description: "Groups code review findings that describe the same underlying problem.",
  model: model(),
  reasoning: "high",
  defaultTools: false,
  tool: false,
});
