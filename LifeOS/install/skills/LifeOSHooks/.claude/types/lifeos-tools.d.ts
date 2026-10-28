// lifeos-tools.d.ts — declaration merges for the built-in tools this build's
// /plugin-types did not table (it merges only Bash, Edit, Read). Shapes copied
// from each tool's input schema so `e.tool === "Write"` narrows `e` in the
// hooks module. Regenerate claude-code.d.ts after an update; keep this beside it.
declare module "claude-code" {
  interface BuiltinToolInputs {
    Write: { file_path: string; content: string };
    MultiEdit: { file_path: string; edits: Array<{ old_string: string; new_string: string; replace_all?: boolean }> };
    NotebookEdit: { notebook_path: string; new_source: string; cell_id?: string; cell_type?: string; edit_mode?: string };
    WebFetch: { url: string; prompt: string };
    WebSearch: { query: string; allowed_domains?: string[]; blocked_domains?: string[] };
    ToolSearch: { query: string; max_results?: number };
    Skill: { skill: string; args?: string };
    Agent: { prompt: string; description: string; subagent_type?: string; model?: string; run_in_background?: boolean; name?: string };
    AskUserQuestion: { questions: unknown[] };
    Glob: { pattern: string; path?: string };
    Grep: { pattern: string; path?: string };
  }
}
