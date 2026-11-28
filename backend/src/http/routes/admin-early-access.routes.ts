import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { EarlyAccessReader, EarlyAccessRecord } from "../../ports/early-access.port.ts";
import { csvCell } from "../csv.ts";

const digest = (value: string) => createHash("sha256").update(value).digest();

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const columns = ["email", "created_at", "source", "platform", "consent", "consent_recorded_at"] as const;

const cells = (signup: EarlyAccessRecord) => [
  signup.email,
  signup.createdAt.toISOString(),
  signup.source ?? "",
  signup.platform ?? "",
  signup.consent ? "yes" : "",
  signup.consentRecordedAt ?? "",
];

function renderPage(signups: EarlyAccessRecord[]) {
  const rows = signups
    .map((signup) => `<tr>${cells(signup).map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Early access signups</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 24px; color: #111; background: #fff; }
  header { display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap; }
  h1 { font-size: 20px; margin: 0; }
  .table { overflow-x: auto; margin-top: 16px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 6px 12px 6px 0; border-bottom: 1px solid #e5e5e5; white-space: nowrap; }
  th { font-weight: 600; color: #555; }
  @media (prefers-color-scheme: dark) {
    body { color: #eee; background: #111; }
    th, td { border-color: #333; }
    th { color: #aaa; }
    a { color: #8ab4ff; }
  }
</style>
</head>
<body>
<header>
  <h1>Early access signups</h1>
  <span>${signups.length} total</span>
  <a href="/admin/early-access.csv">Download CSV</a>
</header>
<div class="table">
<table>
<thead><tr>${columns.map((column) => `<th>${column}</th>`).join("")}</tr></thead>
<tbody>${rows}</tbody>
</table>
</div>
</body>
</html>`;
}

function renderCsv(signups: EarlyAccessRecord[]) {
  const lines = [columns.join(","), ...signups.map((signup) => cells(signup).map(csvCell).join(","))];
  return lines.join("\r\n") + "\r\n";
}

/**
 * Operator-only signup view, protected by HTTP Basic auth (any username,
 * password = ADMIN_TOKEN). Registered only when a token is configured.
 */
export function registerAdminEarlyAccessRoutes(
  app: FastifyInstance,
  signups: EarlyAccessReader,
  adminToken: string,
) {
  const expected = digest(adminToken);

  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.headers({
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    });
    const [scheme, encoded] = (request.headers.authorization ?? "").split(" ");
    if (scheme === "Basic" && encoded) {
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      const password = decoded.slice(decoded.indexOf(":") + 1);
      if (timingSafeEqual(digest(password), expected)) return;
    }
    return reply
      .code(401)
      .header("WWW-Authenticate", 'Basic realm="Gizu admin", charset="UTF-8"')
      .send({ code: "UNAUTHORIZED", message: "authentication required" });
  };

  const load = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      return await signups.list();
    } catch {
      request.log.error({ code: "SIGNUPS_UNAVAILABLE" }, "early access signups could not be read");
      reply.code(503).send({ code: "SIGNUPS_UNAVAILABLE", message: "signups could not be loaded" });
      return undefined;
    }
  };

  app.get("/admin/early-access", { onRequest: authorize }, async (request, reply) => {
    const list = await load(request, reply);
    if (list) return reply.type("text/html; charset=utf-8").send(renderPage(list));
  });

  app.get("/admin/early-access.csv", { onRequest: authorize }, async (request, reply) => {
    const list = await load(request, reply);
    if (!list) return;
    const date = new Date().toISOString().slice(0, 10);
    return reply
      .type("text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="gizu-early-access-${date}.csv"`)
      .send(renderCsv(list));
  });
}
