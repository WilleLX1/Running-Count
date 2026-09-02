/**
 * Production co-op server: serves the built client out of dist/ and hosts the
 * rooms on the same port.
 *
 *   npm run build && npm run serve
 */
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Hub } from "./hub";

const root = fileURLToPath(new URL("../dist", import.meta.url));
const port = Number(process.env.PORT ?? 8787);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  let path = normalize(join(root, decodeURIComponent(url.pathname)));
  if (!path.startsWith(root)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  if (!existsSync(path) || statSync(path).isDirectory()) path = join(root, "index.html");
  if (!existsSync(path)) {
    res.writeHead(404).end("Build the client first: npm run build");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
  createReadStream(path).pipe(res);
});

const hub = new Hub();
hub.attach(server, "/coop");

server.listen(port, () => {
  console.log(`Running Count co-op server on http://localhost:${port}`);
});

process.on("SIGINT", () => {
  hub.stop();
  server.close(() => process.exit(0));
});
