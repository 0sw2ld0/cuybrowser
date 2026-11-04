import { createReadStream, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PAGES = fileURLToPath(new URL("./pages", import.meta.url));

export async function startFixtureServer(): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (pathname === "/archivo") {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="informe.txt"',
      });
      res.end("contenido de prueba");
      return;
    }
    if (pathname === "/redirigir") {
      const { port } = server.address() as AddressInfo;
      res.writeHead(302, { location: `http://localhost:${port}/login` }).end();
      return;
    }
    const file = join(PAGES, `${pathname.replace(/[^a-z0-9-]/gi, "")}.html`);
    if (!existsSync(file)) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, server };
}
