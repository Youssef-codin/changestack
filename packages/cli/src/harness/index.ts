import type { TestRun } from "@changestack/schema";
import type { z } from "zod";
import { claudeCode } from "./claude-code";


export interface RunJsonRequest<T> {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  /** Overrides the harness default (an alias or an exact model ID). */
  model?: string;
}

export interface RunJsonResult<T> {
  data: T;
  /** The model that actually answered, as reported by the harness. */
  model: string;
  /** Tokens the call used, when the harness reports them. */
  usage?: Usage;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number | null;
}

export interface SessionContextRequest {
  root: string;
  /** The PR's head branch; sessions on other branches are ignored. */
  branch: string;
  /** Repo-relative paths changed in the PR. */
  files: string[];
  /** Most characters of transcript to return. 0 turns transcripts off. */
  budget: number;
}

export interface SessionContext {
  /** Condensed transcript text for the classifier prompt. */
  text: string;
  /** Transcript files it came from. */
  sources: string[];
}

export interface TestRunsRequest {
  root: string;
  /** The PR's head branch; sessions on other branches are ignored. */
  branch: string;
}

/** A coding-agent CLI that changestack drives headlessly. */
export interface Harness {
  name: string;
  /** Model used when nothing is pinned. Each harness supplies its own names. */
  defaultModel: string;
  /** Run one prompt with no tools and return output validated against `schema`. Retries once on failure. */
  runJson<T>(req: RunJsonRequest<T>): Promise<RunJsonResult<T>>;
  /** What the agent's own sessions say about this PR, or null when none are found. */
  sessionContext?(req: SessionContextRequest): SessionContext | null;
  /** Test and check commands the agent ran in this PR's sessions, oldest first. */
  testRuns?(req: TestRunsRequest): TestRun[];
}

/** The configured harness. Only Claude Code exists today. */
export function getHarness(): Harness {
  return claudeCode;
}

/** `CHANGESTACK_MODEL` pins an exact model ID; otherwise the harness default applies. */
export function configuredModel(harness: Harness): string {
  return process.env.CHANGESTACK_MODEL?.trim() || harness.defaultModel;
}
