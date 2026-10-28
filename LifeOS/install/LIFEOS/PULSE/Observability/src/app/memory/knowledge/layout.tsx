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

const MEMORY_LABELS = new Set([
  "people", "companies", "ideas", "blogs", "books", "research", "isas", "lessons", "wisdom",
]);

function filterMemoryTree(tree: TreeNode[]): TreeNode[] {
  return tree.filter((node) => MEMORY_LABELS.has(node.label?.toLowerCase() ?? ""));
}

export default function KnowledgeLayout({ children }: { children: React.ReactNode }) {
  // ⌘K is handled globally by CommandPalette (opens WIKI-scoped on this route).
  const { data } = useApi<{ tree: TreeNode[] }>("/api/wiki", { staleTime: 30_000 });

  const memoryTree = data?.tree ? filterMemoryTree(data.tree) : [];

  return (
    <div className="flex h-[calc(100vh-3.5rem)]">
      <WikiSidebar tree={memoryTree} onSearchClick={() => openPalette("wiki")} />
      <div className="flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
