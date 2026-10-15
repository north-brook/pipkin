import { defineAgent } from "eve";
import { reviewModel } from "./lib/models";

export default defineAgent({
  model: reviewModel(),
  reasoning: "high",
  // pipkin talks to GitHub through its own tools; it never needs a shell,
  // web access, or a copy of itself.
  defaultTools: false,
  tool: false,
});
