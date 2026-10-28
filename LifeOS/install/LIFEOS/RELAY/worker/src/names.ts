// The names the Worker speaks and writes: the assistant's and the principal's. deploy.ts pushes them as the DA_NAME and
// PRINCIPAL_NAME bindings from the install's identity, so no line a caller hears or the model reads is ever authored
// with a name in it, and a stale deployment without the bindings still says something plain, never a template token.

export interface Names {
	/** The assistant's name, as callers hear it. */
	da: string;
	/** The principal's first name. */
	principal: string;
}

/** What the Worker says when the bindings are absent. */
export const NEUTRAL_NAMES: Names = { da: "your assistant", principal: "the owner" };

/** The names from the Worker's bindings; an empty or missing binding falls back to the plain wording. */
export function namesFrom(env: { DA_NAME?: string; PRINCIPAL_NAME?: string }): Names {
	return { da: env.DA_NAME?.trim() || NEUTRAL_NAMES.da, principal: env.PRINCIPAL_NAME?.trim() || NEUTRAL_NAMES.principal };
}
