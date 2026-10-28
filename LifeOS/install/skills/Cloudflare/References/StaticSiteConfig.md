# Static Site Config

The two config files a Workers-first project carries (SKILL.md § Workers-first doctrine). A static site (HTML/CSS/JS/JSON, with or without a build step) deploys as a Worker with Static Assets; the config sets dev URLs off explicitly (SKILL.md § Dev-URLs-off doctrine).

```ts
// cloudflare.config.ts
import { defineConfig } from "cf/config";

export default defineConfig({
	worker: {
		name: "<project>",
		compatibilityDate: "<recent date>",
		workersDev: false,     // dev URLs off — the custom domain is the ONLY URL
		previewUrls: false,
		domains: ["<domain>"],
	},
});
```

```ts
// vite.config.ts — publicDir is the assets directory
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({ publicDir: "public", plugins: [cloudflare()] });
```
