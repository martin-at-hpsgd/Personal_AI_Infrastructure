// lifeos-tex Worker configuration (cf). @version 0.2.0
// The always-on front door for Tex (Relay ISA F28): Linq webhooks in, one Inbox Durable Object holding each event
// until the Mac's bridge takes it; Twilio calls into one Call Durable Object per call (F29). Deployed only ever through CfEnv.ts (P6); its releases are in CHANGELOG.md.
// Secrets are set out of band and MUST stay declared here as bindings.secret(): cf deploy deletes undeclared ones.
import { bindings, defineConfig, exports } from "cf/config";

export default defineConfig({
	worker: {
		name: "lifeos-tex",
		compatibilityDate: "2026-09-21",
		entrypoint: "src/index.ts",
		workersDev: true,
		previewUrls: false,
		observability: { enabled: true },
		env: {
			INBOX: bindings.durableObject({ worker: "lifeos-tex", exportName: "Inbox" }),
			LINQ_WEBHOOK_SECRET: bindings.secret(),
			LINQ_API_KEY: bindings.secret(),
			BRIDGE_TOKEN: bindings.secret(),
			PRINCIPAL_HANDLES: bindings.secret(),
			// F29 calls.
			CALL: bindings.durableObject({ worker: "lifeos-tex", exportName: "Call" }),
			TWILIO_AUTH_TOKEN: bindings.secret(),
			ANTHROPIC_API_KEY: bindings.secret(),
			TALKER_MODEL: bindings.secret(),
			PASSPHRASE_CHECK: bindings.secret(),
			CALL_VOICE: bindings.secret(),
			// ISC-396: {{DA_NAME}}'s Fish voice on calls (set by `deploy.ts voice Fish:…`).
			FISH_API_KEY: bindings.secret(),
			FISH_MODEL: bindings.secret(),
			// Fish voice ISA F7: the principal's pronunciation rules for every call line (set by `deploy.ts pronunciations`).
			PRONUNCIATIONS: bindings.secret(),
			// The assistant's name and the principal's first name for every spoken and texted line (set by deploy.ts from the install's identity).
			DA_NAME: bindings.secret(),
			PRINCIPAL_NAME: bindings.secret(),
		},
		exports: {
			Inbox: exports.durableObject({ storage: "sqlite" }),
			Call: exports.durableObject({ storage: "sqlite" }),
		},
	},
});
