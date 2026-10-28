export function selectionAfterRefresh(selected:string, previous:readonly string[], remaining:readonly string[]):string {
  if(!selected.startsWith('pulse-') || remaining.includes(selected))return selected;
  const index=previous.indexOf(selected);
  for(let i=index-1;i>=0;i--)if(remaining.includes(previous[i]))return previous[i];
  for(let i=index+1;i<previous.length;i++)if(remaining.includes(previous[i]))return previous[i];
  return remaining[0]||'/';
}
