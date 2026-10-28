import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import MarkdownRenderer from "./MarkdownRenderer";

function render(content: string): string {
  return renderToStaticMarkup(<MarkdownRenderer content={content} />);
}

describe("MarkdownRenderer", () => {
  test("removes active HTML and unsafe attributes and URLs", () => {
    const html = render(`
<iframe srcdoc="<script>alert(1)</script>"></iframe>
<meta http-equiv="refresh" content="0;url=https://example.com">
<script>alert(2)</script>
<object data="https://example.com"></object>
<style>body{display:none}</style>
<img src="x" onerror="alert(3)">
<a href="javascript:alert(4)">unsafe link</a>
[[x|<img src=x onerror=alert(5)>]]
`);

    for (const fragment of ["<iframe", "srcdoc=", "<meta", "http-equiv=", "<script", "<object", "<style", 'onerror="', "javascript:"]) {
      expect(html).not.toContain(fragment);
    }
    expect(html).toContain("unsafe link");
    expect(html).toContain("&lt;img src=x onerror=alert(5)&gt;");
    expect(html).not.toMatch(/<img[^>]*\bonerror=/);
  });

  test("renders markdown and wikilinks with syntax highlighting", () => {
    const html = render(`# Heading

- First
- Second

| Name | Value |
| --- | --- |
| A | B |

\`\`\`js
const answer = 42;
\`\`\`

[[Example Page|Read more]]`);

    expect(html).toContain("<h1");
    expect(html).toContain("Heading</h1>");
    expect(html).toContain("<ul");
    expect(html).toContain("<li");
    expect(html).toContain("<table");
    expect(html).toContain("<td");
    expect(html).toContain("hljs-");
    expect(html).toContain('href="/system?doc=example-page"');
    expect(html).toContain("Read more</a>");
  });

  test("escapes wikilink slugs in generated HTML", () => {
    const html = render('[[x" onmouseover="alert(1)|Safe]]');
    expect(html).not.toContain(' onmouseover="alert(1)"');
    expect(html).toContain("Safe</a>");
  });
});
