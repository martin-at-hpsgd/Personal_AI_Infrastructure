#!/usr/bin/env bun
/**
 * RenderTemplate.ts - LifeOS Templating Engine
 *
 * Renders Handlebars templates with YAML data sources.
 *
 * Usage:
 *   bun run RenderTemplate.ts --template <path> --data <path> [--output <path>] [--preview]
 *
 * Examples:
 *   bun run RenderTemplate.ts --template Primitives/Roster.hbs --data Data/Agents.yaml
 *   bun run RenderTemplate.ts -t Primitives/Voice.hbs -d Data/VoicePresets.yaml -o Compiled/voice.md
 *   bun run RenderTemplate.ts --template Primitives/Gate.hbs --data Data/Gates.yaml --preview
 */

import Handlebars from 'handlebars';
import { parse as parseYaml } from 'yaml';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { parseArgs } from 'util';

// ============================================================================
// Custom Handlebars Helpers
// ============================================================================

// Uppercase text
Handlebars.registerHelper('uppercase', (str: string) => {
  return str?.toUpperCase() ?? '';
});

// Lowercase text
Handlebars.registerHelper('lowercase', (str: string) => {
  return str?.toLowerCase() ?? '';
});

// Title case text
Handlebars.registerHelper('titlecase', (str: string) => {
  return str?.replace(/\w\S*/g, (txt) =>
    txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
  ) ?? '';
});

// Indent text by N spaces
Handlebars.registerHelper('indent', (str: string, spaces: number) => {
  if (!str) return '';
  const indent = ' '.repeat(typeof spaces === 'number' ? spaces : 2);
  return str.split('\n').map(line => indent + line).join('\n');
});

// Join array with separator
Handlebars.registerHelper('join', (arr: string[], separator: string) => {
  if (!Array.isArray(arr)) return '';
  return arr.join(typeof separator === 'string' ? separator : ', ');
});

// Check if value equals another
Handlebars.registerHelper('eq', (a: unknown, b: unknown) => a === b);

// Check if value is greater than
Handlebars.registerHelper('gt', (a: number, b: number) => a > b);

// Check if value is less than
Handlebars.registerHelper('lt', (a: number, b: number) => a < b);

// Check if array includes value
Handlebars.registerHelper('includes', (arr: unknown[], value: unknown) => {
  return Array.isArray(arr) && arr.includes(value);
});

// Get current date/time
Handlebars.registerHelper('now', (format?: string) => {
  const now = new Date();
  if (format === 'date') return now.toISOString().split('T')[0];
  if (format === 'time') return now.toTimeString().split(' ')[0];
  return now.toISOString();
});

// Pluralize word based on count
Handlebars.registerHelper('pluralize', (count: number, singular: string, plural?: string) => {
  const pluralForm = typeof plural === 'string' ? plural : `${singular}s`;
  return count === 1 ? singular : pluralForm;
});

// Format number with commas
Handlebars.registerHelper('formatNumber', (num: number) => {
  return num?.toLocaleString() ?? '';
});

// Calculate percentage
Handlebars.registerHelper('percent', (value: number, total: number, decimals = 0) => {
  if (!total) return '0';
  return ((value / total) * 100).toFixed(typeof decimals === 'number' ? decimals : 0);
});

// Truncate text to length
Handlebars.registerHelper('truncate', (str: string, length: number) => {
  if (!str) return '';
  const maxLen = typeof length === 'number' ? length : 100;
  return str.length > maxLen ? str.substring(0, maxLen) + '...' : str;
});

// Default value if undefined
Handlebars.registerHelper('default', (value: unknown, defaultValue: unknown) => {
  return value ?? defaultValue;
});

// JSON stringify
Handlebars.registerHelper('json', (obj: unknown, pretty = false) => {
  return JSON.stringify(obj, null, pretty ? 2 : undefined);
});

// Markdown code block
Handlebars.registerHelper('codeblock', (code: string, language?: string) => {
  const lang = typeof language === 'string' ? language : '';
  return `\`\`\`${lang}\n${code}\n\`\`\``;
});

// Repeat helper for generating repeated content
Handlebars.registerHelper('repeat', (count: number, options: Handlebars.HelperOptions) => {
  let result = '';
  for (let i = 0; i < count; i++) {
    result += options.fn({ index: i, first: i === 0, last: i === count - 1 });
  }
  return result;
});

// ============================================================================
// Template Engine
// ============================================================================

interface RenderOptions {
  templatePath: string;
  /** A data file (.yaml or .json). Either this or `data` is required. */
  dataPath?: string;
  /** The data itself, in place of a data file. */
  data?: Record<string, unknown>;
  outputPath?: string;
  preview?: boolean;
}

/** The Templates directory beside Prompting/Tools (a copy placed inside Templates/ also resolves). */
export function templatesRoot(): string {
  const base = dirname(dirname(import.meta.path));
  return basename(base) === 'Templates' ? base : resolve(base, 'Templates');
}

/**
 * Absolute paths are used as given. A relative path is looked up under Templates/ first (Primitives/Roster.hbs,
 * Data/Agents.yaml), then under the current directory (a data file of your own); when neither exists it names the
 * Templates/ location so the "not found" error points at the documented place.
 */
export function resolveTemplatePath(path: string): string {
  if (path.startsWith('/')) return path;

  const underTemplates = resolve(templatesRoot(), path);
  if (existsSync(underTemplates)) return underTemplates;
  const underCwd = resolve(process.cwd(), path);
  return existsSync(underCwd) ? underCwd : underTemplates;
}

function loadTemplate(templatePath: string): HandlebarsTemplateDelegate {
  const fullPath = resolveTemplatePath(templatePath);

  if (!existsSync(fullPath)) {
    throw new Error(`Template not found: ${fullPath}`);
  }

  const templateSource = readFileSync(fullPath, 'utf-8');
  return Handlebars.compile(templateSource);
}

function loadData(dataPath: string): Record<string, unknown> {
  const fullPath = resolveTemplatePath(dataPath);

  if (!existsSync(fullPath)) {
    throw new Error(`Data file not found: ${fullPath}`);
  }

  const dataSource = readFileSync(fullPath, 'utf-8');

  // Support both YAML and JSON
  if (dataPath.endsWith('.json')) {
    return JSON.parse(dataSource);
  }

  return parseYaml(dataSource) as Record<string, unknown>;
}

function registerPartials(templatesDir: string): void {
  const partialsDir = resolve(templatesDir, 'Partials');

  if (!existsSync(partialsDir)) return;

  const files = Bun.spawnSync(['ls', partialsDir]).stdout.toString().trim().split('\n');

  for (const file of files) {
    if (file.endsWith('.hbs')) {
      const partialName = basename(file, '.hbs');
      const partialPath = resolve(partialsDir, file);
      const partialSource = readFileSync(partialPath, 'utf-8');
      Handlebars.registerPartial(partialName, partialSource);
    }
  }
}

export function renderTemplate(options: RenderOptions): string;
export function renderTemplate(templatePath: string, data: Record<string, unknown>): string;
export function renderTemplate(first: RenderOptions | string, second?: Record<string, unknown>): string {
  const options: RenderOptions = typeof first === 'string' ? { templatePath: first, data: second } : first;
  if (typeof options.templatePath !== 'string' || !options.templatePath) {
    throw new Error('renderTemplate needs a template path: renderTemplate(path, data) or renderTemplate({ templatePath, dataPath | data })');
  }
  if (options.data === undefined && !options.dataPath) {
    throw new Error('renderTemplate needs data: pass a data object, or { dataPath } for a .yaml or .json file');
  }
  const templatesDir = templatesRoot();

  // Register any partials
  registerPartials(templatesDir);

  // Load and compile template
  const template = loadTemplate(options.templatePath);

  // Load data
  const data = options.data ?? loadData(options.dataPath!);

  // Render
  const rendered = template(data);

  // Output
  if (options.preview) {
    console.log('\n=== PREVIEW ===\n');
    console.log(rendered);
    console.log('\n=== END PREVIEW ===\n');
  }

  if (options.outputPath) {
    const outputFullPath = resolveTemplatePath(options.outputPath);
    writeFileSync(outputFullPath, rendered);
    console.log(`✓ Rendered to: ${outputFullPath}`);
  }

  return rendered;
}

// ============================================================================
// CLI Interface
// ============================================================================

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      template: { type: 'string', short: 't' },
      data: { type: 'string', short: 'd' },
      output: { type: 'string', short: 'o' },
      preview: { type: 'boolean', short: 'p' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help || !values.template || !values.data) {
    console.log(`
LifeOS Template Renderer

Usage:
  bun run RenderTemplate.ts --template <path> --data <path> [options]

Options:
  -t, --template <path>  Template file (.hbs)
  -d, --data <path>      Data file (.yaml or .json)
  -o, --output <path>    Output file (optional, prints to stdout if omitted)
  -p, --preview          Show preview in console
  -h, --help             Show this help

Examples:
  bun run RenderTemplate.ts -t Primitives/Roster.hbs -d Data/Agents.yaml -p
  bun run RenderTemplate.ts -t Primitives/Voice.hbs -d Data/VoicePresets.yaml -o Compiled/voice.md

Available Helpers:
  {{uppercase str}}           - Convert to uppercase
  {{lowercase str}}           - Convert to lowercase
  {{titlecase str}}           - Convert to title case
  {{indent str spaces}}       - Indent text by N spaces
  {{join arr separator}}      - Join array with separator
  {{eq a b}}                  - Check equality
  {{gt a b}} / {{lt a b}}     - Greater/less than
  {{includes arr value}}      - Check if array includes value
  {{now format}}              - Current date/time
  {{pluralize count word}}    - Pluralize based on count
  {{formatNumber num}}        - Format with commas
  {{percent value total}}     - Calculate percentage
  {{truncate str length}}     - Truncate to length
  {{default value fallback}}  - Default value if undefined
  {{json obj pretty}}         - JSON stringify
  {{codeblock code lang}}     - Markdown code block
  {{repeat count}}...{{/repeat}} - Repeat content N times
`);
    process.exit(values.help ? 0 : 1);
  }

  try {
    const rendered = renderTemplate({
      templatePath: values.template,
      dataPath: values.data,
      outputPath: values.output,
      preview: values.preview,
    });
    // Help says stdout when --output is omitted; --preview already printed it.
    if (!values.output && !values.preview) process.stdout.write(rendered + '\n');
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.main) {
  main();
}
