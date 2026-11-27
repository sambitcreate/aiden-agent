import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vite";

/** Fixed test routes the live-frame E2E drives (see README.md). */
function fixtureRoutes(): Plugin {
  return {
    name: "design-live-fixture-routes",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? "/", "http://fixture.invalid");
        const redirect = (status: number, location: string) => {
          response.statusCode = status;
          response.setHeader("Location", location);
          response.end();
        };
        if (request.method === "GET" && url.pathname === "/go-out") return redirect(302, "https://example.com/");
        if (request.method === "GET" && url.pathname === "/go-login") return redirect(302, "/login");
        if (request.method === "GET" && url.pathname === "/r-own") {
          const port = Number(url.searchParams.get("port"));
          return redirect(307, `http://127.0.0.1:${Number.isInteger(port) ? port : 9}/`);
        }
        if (request.method === "GET" && url.pathname === "/r-evil") return redirect(302, "http://localhost.evil.test/");
        if (request.method === "POST" && url.pathname === "/api/login") {
          request.resume();
          response.setHeader("Set-Cookie", "sid=fixture; HttpOnly; Path=/");
          return redirect(303, "/login?ok=1");
        }
        if (request.method === "GET" && url.pathname === "/api/me") {
          const sid = /(?:^|;\s*)sid=([^;]+)/u.exec(request.headers.cookie ?? "")?.[1];
          response.statusCode = sid ? 200 : 401;
          response.setHeader("Content-Type", "text/plain");
          return response.end(sid ?? "signed out");
        }
        if (request.method === "GET" && url.pathname === "/framed") {
          response.setHeader("Content-Type", "text/html");
          response.setHeader("X-Frame-Options", "DENY");
          response.setHeader("Content-Security-Policy", "frame-ancestors 'none'; script-src 'self'");
          return response.end('<!doctype html><title>Framed</title><h1 id="framed">Framed content</h1>');
        }
        if (request.method === "GET" && url.pathname === "/reporting") {
          const to = url.searchParams.get("to") ?? "https://127.0.0.1:9/r";
          response.setHeader("Content-Type", "text/html");
          response.setHeader("Reporting-Endpoints", `e="${to}"`);
          response.setHeader("Report-To", JSON.stringify({ group: "e", max_age: 60, endpoints: [{ url: to }] }));
          response.setHeader("NEL", JSON.stringify({ report_to: "e", max_age: 60, success_fraction: 1, failure_fraction: 1 }));
          response.setHeader("Content-Security-Policy", "script-src 'none'; report-to e");
          return response.end('<!doctype html><title>Reporting</title><h1 id="reporting">Reporting</h1><script>window.blocked = 1</script>');
        }
        if (request.method === "GET" && url.pathname === "/f.zip") {
          response.setHeader("Content-Type", "application/zip");
          response.setHeader("Content-Disposition", 'attachment; filename="f.zip"');
          return response.end("PK");
        }
        next();
      });
    },
  };
}

export default defineConfig({
  // Inside the fixture copy, so the dep optimizer never writes into the repo's
  // node_modules through the symlink.
  cacheDir: ".vite-cache",
  plugins: [react(), fixtureRoutes()],
});
