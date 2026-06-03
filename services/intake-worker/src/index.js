// services/intake-worker/src/index.js
import { handleIntake } from "./handler.js";
import { handleSubRead } from "./sub-read.js";

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/sub/")) return handleSubRead(request, env);
    return handleIntake(request, env);
  },
};
