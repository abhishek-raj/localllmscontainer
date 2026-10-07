import { loadConfig } from "./config.js";
import { createGateway } from "./gateway.js";

const config = loadConfig(process.env);
const server = createGateway(config);

server.on("error", (error: NodeJS.ErrnoException) => {
  console.error(JSON.stringify({ event: "server_error", code: error.code ?? "unknown" }));
  process.exitCode = 1;
});
server.listen(config.port, "0.0.0.0", () => {
  console.log(JSON.stringify({ event: "listening", port: config.port }));
});

function shutdown(): void {
  console.log(JSON.stringify({ event: "shutdown" }));
  const timer = setTimeout(() => {
    server.closeAllConnections();
  }, 10000);
  timer.unref();
  server.close(() => clearTimeout(timer));
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
