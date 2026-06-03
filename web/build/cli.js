import { build } from "./build.js";

const entries = build();
console.log(`Built ${entries.length} entries → web/dist/`);
