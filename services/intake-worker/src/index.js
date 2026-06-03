// services/intake-worker/src/index.js
import { handleIntake } from "./handler.js";

export default {
  async fetch(request, env) {
    return handleIntake(request, env);
  },
};
