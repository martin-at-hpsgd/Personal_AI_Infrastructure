"use client";

import { useApi } from "@/lib/api";
import WikiSidebar from "@/components/wiki/WikiSidebar";
import { openPalette } from "@/lib/palette/events";

interface TreeNode {
  label: string;
  slug?: string;
  category?: string;
  children?: TreeNode[];
  count?: number;
}

function filterDocsTree(tree: TreeNode[]): TreeNode[] {
  return tree.filter((node) => {
    const label = node.label?.toLowerCase() ?? "";
    return label === "documentation";
  });
}

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  // ⌘K is handled globally by CommandPalette (opens WIKI-scoped on this route).
  const { data } = useApi<{ tree: TreeNode[] }>("/api/wiki", { staleTime: 30_000 });

  const docsTree = data?.tree ? filterDocsTree(data.tree) : [];

  return (
    <div className="flex h-[calc(100vh-3.5rem)]">
      <WikiSidebar tree={docsTree} onSearchClick={() => openPalette("wiki")} />
      <div className="flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
