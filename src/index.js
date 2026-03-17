// src/index.js
import { createServer } from "node:http";
import config from "./config.js";
import app from "./app.js";

const server = createServer(app);

server.listen(config.app.port, () => {
  console.log(`[APP] running at http://localhost:${config.app.port}`);
});
