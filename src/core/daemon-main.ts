import { tools } from "../tools/index.js";
import { runDaemon } from "./daemon.js";

runDaemon(tools).catch((err) => {
  console.error(err);
  process.exit(1);
});
