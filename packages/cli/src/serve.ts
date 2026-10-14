import { existsSync, readFileSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { Annotation, type ReviewPayload } from "@changestack/schema";
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

      const rel = normalize(url.pathname === "/" ? "/index.html" : url.pathname);
      const file = Bun.file(join(VIEWER_DIR, rel));
      if (await file.exists()) return new Response(file);
      return new Response(Bun.file(join(VIEWER_DIR, "index.html")));
    },
  });

  console.error(`changestack: reviewing ${root}`);
  console.error(`changestack: open http://${server.hostname}:${server.port}`);
}
