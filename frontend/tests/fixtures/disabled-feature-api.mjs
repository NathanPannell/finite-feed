import { createServer } from "node:http";

const port = Number(process.argv[2]);
const server = createServer((request, response) => {
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  if (request.url === "/health") {
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (request.url === "/api/features") {
    response.end(JSON.stringify({ match_lab_homepage_visible: false }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ detail: "Not found" }));
});

server.listen(port, "127.0.0.1");
