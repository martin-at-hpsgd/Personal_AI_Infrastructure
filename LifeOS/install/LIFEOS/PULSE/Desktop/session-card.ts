/** Separate the status glyph and leading subject without changing the stored title. The heading is always uppercase: one rule for every card, whatever provider or hook produced the title. */
export function sessionCardTitle(title: string, sessionName?:string) {
  const text = title.trim();
  const first = [...new Intl.Segmenter(undefined, {granularity:'grapheme'}).segment(text)][0]?.segment || '';
  const hasIcon = /\p{Extended_Pictographic}/u.test(first);
  const content = hasIcon ? text.slice(first.length).trim() : text;
  const divider = content.indexOf(' | ');
  return {
    icon: hasIcon ? first : '›_',
    heading: (sessionName?.trim() || (divider < 0 ? content : content.slice(0, divider).trim())).toUpperCase(),
    detail: divider < 0 ? (sessionName && content.toUpperCase()!==sessionName.toUpperCase() ? content : '') : content.slice(divider + 3).trim(),
  };
}
