import { defineAgent } from "eve";
import { model } from "../../lib/models";

export default defineAgent({
  description: "Decides which of pipkin's earlier findings a newer commit has fixed.",
  model: model(),
  reasoning: "high",
  defaultTools: false,
  tool: false,
});
