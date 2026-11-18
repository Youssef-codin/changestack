import { existsSync, readFileSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { Annotation, Draft, DraftScope, type ReviewPayload } from "@changestack/schema";
import { z } from "zod";
import { currentScope, deleteDraft, loadDrafts, upsertDrafts } from "./drafts";
import { workingDiff } from "./git";
import { repoRoot, reviewPath } from "./paths";

/** Built viewer location. Override with CHANGESTACK_VIEWER_DIR (e.g. for the compiled binary). */
const VIEWER_DIR = process.env.CHANGESTACK_VIEWER_DIR ?? resolve(import.meta.dir, "../../viewer/dist");

function loadAnnotation(root: string): Annotation | null {
  const path = reviewPath(root, "latest");
  if (!existsSync(path)) return null;
  const parsed = Annotation.safeParse(JSON.parse(readFileSync(path, "utf8")));
  return parsed.success ? parsed.data : null;
}

const DraftsPut = z.object({ drafts: z.array(Draft).max(1000) });

/**
 * /api/drafts?scope=…   GET → DraftSet · PUT {drafts} → upsert by id · DELETE /api/drafts/<id>
 * `scope` defaults to the current branch. Writes use PUT/DELETE with JSON, which browsers
 * always preflight, and we answer no CORS, so other sites can't write drafts.
 */
async function handleDrafts(req: Request, url: URL, root: string): Promise<Response> {
  const scopeParam = url.searchParams.get("scope");
  const scope = scopeParam === null ? currentScope(root) : DraftScope.safeParse(scopeParam).data;
  if (!scope) return Response.json({ error: "bad scope" }, { status: 400 });

  const id = url.pathname.slice("/api/drafts/".length);
  if (req.method === "GET" && url.pathname === "/api/drafts") return Response.json(loadDrafts(root, scope));
  if (req.method === "DELETE" && id) return Response.json(deleteDraft(root, scope, decodeURIComponent(id)));
  if (req.method === "PUT" && url.pathname === "/api/drafts") {
    if (!req.headers.get("content-type")?.startsWith("application/json")) {
      return Response.json({ error: "expected application/json" }, { status: 415 });
    }
    const body = DraftsPut.safeParse(await req.json().catch(() => null));
    if (!body.success) return Response.json({ error: body.error.message }, { status: 400 });
    return Response.json(upsertDrafts(root, scope, body.data.drafts));
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

export function serve(args: string[]): void {
  const portIdx = args.indexOf("--port");
  const port = portIdx !== -1 ? Number(args[portIdx + 1]) : 4317;
  const root = repoRoot();

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/api/review") {
        const annotation = loadAnnotation(root);
        const payload: ReviewPayload = { annotation, diff: workingDiff(root, annotation?.base ?? "HEAD") };
        return Response.json(payload);
      }

      if (url.pathname === "/api/drafts" || url.pathname.startsWith("/api/drafts/")) {
        return handleDrafts(req, url, root);
      }

      const rel = normalize(url.pathname === "/" ? "/index.html" : url.pathname);
      const file = Bun.file(join(VIEWER_DIR, rel));
      if (await file.exists()) return new Response(file);
      return new Response(Bun.file(join(VIEWER_DIR, "index.html")));
    },
  });

  console.error(`changestack: reviewing ${root}`);
  console.error(`changestack: open http://${server.hostname}:${server.port}`);
}
