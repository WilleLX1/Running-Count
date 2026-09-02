import { defineConfig } from "vite";
import { coopPlugin } from "./server/plugin";

export default defineConfig({
  plugins: [coopPlugin()],
  server: {
    host: true,
  },
});
