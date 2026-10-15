import { chatgpt } from "eve/models/openai";

// Both models bill the ChatGPT subscription that Codex is signed in to on the
// host. Override with PIPKIN_REVIEW_MODEL / PIPKIN_TRIAGE_MODEL.

/** Deep reviewers: bug hunting, history, spec. */
export const reviewModel = () => chatgpt(process.env.PIPKIN_REVIEW_MODEL ?? "gpt-6.1-sol");

/** Cheap passes: eligibility, summaries, scoring. */
export const triageModel = () => chatgpt(process.env.PIPKIN_TRIAGE_MODEL ?? "gpt-6-luna");
