import { join, normalize, resolve } from "node:path";
import { type Annotation, type BriefingFacts, type ClassifyStatus, type CodeRabbitComment, Draft, DraftScope, type ReviewPayload, type SubmitResult } from "@changestack/schema";
import { z } from "zod";
import { refreshCi } from "./facts";
import { deleteDraft, loadDrafts, prScope, removeDrafts, upsertDrafts } from "./drafts";
import { type PullRequest, type ReviewComment, submitReview } from "./gh";

/** Built viewer location when running from source. Override with CHANGESTACK_VIEWER_DIR. */
const VIEWER_DIR = process.env.CHANGESTACK_VIEWER_DIR ?? resolve(import.meta.dir, "../../viewer/dist");
/** The viewer embedded in the compiled binary (scripts/build.ts): URL path → embedded file. */
const EMBEDDED = (globalThis as { __CHANGESTACK_VIEWER__?: Record<string, string> }).__CHANGESTACK_VIEWER__;

/** A viewer file by URL path; unknown paths get index.html, so the page handles them. */
async function viewerFile(path: string) {
  const rel = normalize(path === "/" ? "/index.html" : path);
  if (EMBEDDED && !process.env.CHANGESTACK_VIEWER_DIR) return Bun.file(EMBEDDED[rel] ?? EMBEDDED["/index.html"]!);
  const file = Bun.file(join(VIEWER_DIR, rel));
  return (await file.exists()) ? file : Bun.file(join(VIEWER_DIR, "index.html"));
}

/** What the server shows. The open command mutates `status` and `annotation` as classification runs. */
export interface ReviewState {
  root: string;
  pr: PullRequest;
  diff: string;
  status: ClassifyStatus;
  annotation: Annotation | null;
  /** Null until gathered; see facts.ts. */
  facts: BriefingFacts | null;
  /** CodeRabbit's comments; filled in once the fetch at startup returns. */
  coderabbit: CodeRabbitComment[];
}

const DraftsPut = z.object({ drafts: z.array(Draft).max(1000) });

/**
 * /api/drafts?scope=…   GET → DraftSet · PUT {drafts} → upsert by id · DELETE /api/drafts/<id>
 * `scope` defaults to this PR. Writes use PUT/DELETE/POST with JSON, which browsers
 * always preflight, and we answer no CORS, so other sites can't write drafts or post reviews.
 */
async function handleDrafts(req: Request, url: URL, state: ReviewState): Promise<Response> {
  const scopeParam = url.searchParams.get("scope");
  const scope = scopeParam === null ? prScope(state.pr.number) : DraftScope.safeParse(scopeParam).data;
  if (!scope) return Response.json({ error: "bad scope" }, { status: 400 });

  const id = url.pathname.slice("/api/drafts/".length);
  if (req.method === "GET" && url.pathname === "/api/drafts") return Response.json(loadDrafts(state.root, scope));
  if (req.method === "DELETE" && id) return Response.json(deleteDraft(state.root, scope, decodeURIComponent(id)));
  if (req.method === "PUT" && url.pathname === "/api/drafts") {
    if (!isJson(req)) return Response.json({ error: "expected application/json" }, { status: 415 });
    const body = DraftsPut.safeParse(await req.json().catch(() => null));
    if (!body.success) return Response.json({ error: body.error.message }, { status: 400 });
    return Response.json(upsertDrafts(state.root, scope, body.data.drafts));
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

const isJson = (req: Request) => req.headers.get("content-type")?.startsWith("application/json") ?? false;

/**
 * POST /api/submit {body?} → post every draft of this PR as one COMMENT review.
 * Active drafts become line comments; outdated ones can't be placed on a line, so they go
 * in the review body with the line they were written against. Drafts are cleared only
 * after GitHub accepts the review.
 */
async function handleSubmit(req: Request, state: ReviewState): Promise<Response> {
  if (!isJson(req)) return Response.json({ error: "expected application/json" }, { status: 415 });
  const input = z.object({ body: z.string().max(20_000).optional() }).safeParse(await req.json().catch(() => null));
  if (!input.success) return Response.json({ error: input.error.message }, { status: 400 });

  const scope = prScope(state.pr.number);
  const drafts = loadDrafts(state.root, scope).drafts;
  if (drafts.length === 0) return Response.json({ error: "no drafts to submit" }, { status: 400 });

  const active = drafts.filter((d) => d.status === "active");
  const outdated = drafts.filter((d) => d.status === "outdated");
  const comments: ReviewComment[] = active.map((d) => ({
    path: d.file,
    line: d.line,
    side: d.side === "old" ? "LEFT" : "RIGHT",
    body: d.body,
  }));
  const quote = (s: string) => s.split("\n").map((l) => `> ${l}`).join("\n");
  const body = [
    input.data.body?.trim() ?? "",
    ...outdated.map((d) => `**${d.file}:${d.line}** (line changed since this comment was written)\n${quote(d.lineText)}\n\n${d.body}`),
  ].filter(Boolean).join("\n\n---\n\n");

  try {
    // Pin to the head the reviewer was looking at, so line numbers match.
    const url = submitReview(state.root, state.pr, state.pr.headRefOid, { body, comments });
    removeDrafts(state.root, scope, new Set(drafts.map((d) => d.id)));
    const result: SubmitResult = { url, posted: comments.length, inBody: outdated.length };
    return Response.json(result);
  } catch (err) {
    // Drafts stay put; the viewer shows the error and the reviewer can retry.
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}

/**
 * Serve the viewer and API for one PR. Tries `port`, then any free port.
 * `retry` starts classification again after it failed; it returns false when there's nothing to retry.
 */
export function startServer(state: ReviewState, port: number, retry: () => boolean) {
  const ciTries = { busy: false, at: Date.now() };
  const fetch = async (req: Request) => {
    const url = new URL(req.url);

    if (url.pathname === "/api/review") {
      if (state.facts) refreshCi(state.root, state.pr, state.facts, ciTries);
      const payload: ReviewPayload = {
        pr: {
          number: state.pr.number,
          title: state.pr.title,
          url: state.pr.url,
          baseRefName: state.pr.baseRefName,
          headRefName: state.pr.headRefName,
          baseRefOid: state.pr.baseRefOid,
          headRefOid: state.pr.headRefOid,
        },
        status: state.status,
        annotation: state.annotation,
        diff: state.diff,
        facts: state.facts,
        coderabbit: state.coderabbit,
      };
      return Response.json(payload);
    }
    // Cheap liveness check, so the viewer can tell when the CLI has stopped.
    if (url.pathname === "/api/ping") return Response.json({ ok: true });
    if (url.pathname === "/api/classify" && req.method === "POST") {
      if (!isJson(req)) return Response.json({ error: "expected application/json" }, { status: 415 });
      if (!retry()) return Response.json({ error: `can't classify while ${state.status.state}` }, { status: 409 });
      return Response.json(state.status);
    }
    if (url.pathname === "/api/drafts" || url.pathname.startsWith("/api/drafts/")) return handleDrafts(req, url, state);
    if (url.pathname === "/api/submit" && req.method === "POST") return handleSubmit(req, state);
    if (url.pathname.startsWith("/api/")) return Response.json({ error: "not found" }, { status: 404 });

    return new Response(await viewerFile(url.pathname));
  };

  try {
    return Bun.serve({ port, hostname: "127.0.0.1", fetch });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EADDRINUSE") throw err;
    return Bun.serve({ port: 0, hostname: "127.0.0.1", fetch });
  }
}

/** Open `url` in the default browser. Best effort: the URL is printed either way. */
export function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? ["open", url]
    : process.platform === "win32" ? ["cmd", "/c", "start", "", url]
    : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }).unref();
  } catch {
    // no opener installed
  }
}
