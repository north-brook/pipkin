import { z } from "zod";

export const Finding = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  startLine: z.number().int().positive().nullable(),
  title: z.string(),
  body: z.string(),
  source: z.string().nullable(),
});
export type Finding = z.infer<typeof Finding>;

export const Findings = z.object({ findings: z.array(Finding) });

export const Score = z.object({
  reasoning: z.string(),
  score: z.number().int().min(0).max(100),
});

export const Triage = z.object({
  review: z.boolean(),
  reason: z.string(),
  summary: z.string(),
});

export const AXES = {
  bugs: "Bugs",
  history: "Bugs",
  comments: "Bugs",
  rules: "Standards",
  precedent: "Standards",
  spec: "Spec",
} as const;
export type Reviewer = keyof typeof AXES;
export type Axis = (typeof AXES)[Reviewer];
