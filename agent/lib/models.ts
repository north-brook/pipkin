import { chatgpt } from "eve/models/openai";

// Every pipkin agent runs on the same model, billed to the ChatGPT
// subscription that Codex is signed in to on the host. Override with
// PIPKIN_MODEL.
export const model = () => chatgpt(process.env.PIPKIN_MODEL ?? "gpt-6.1-sol");
