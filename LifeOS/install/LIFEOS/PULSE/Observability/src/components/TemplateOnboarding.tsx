"use client";

import { useEffect, useState } from "react";
import { Sparkles, MessageSquare, FolderOpen, X } from "lucide-react";
import { useApi } from "@/lib/api";

interface OnboardingState {
  templateMode: boolean;
  daName: string;
  interviewCommand: string;
}

const DISMISSED_KEY = "pai:template-onboarding:dismissed";

export default function TemplateOnboarding() {
  const { data } = useApi<OnboardingState | null>("/api/onboarding/state");
  const state = data ?? null;
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined" && window.sessionStorage.getItem(DISMISSED_KEY) === "1") {
      setDismissed(true);
    }
  }, []);

  if (!state || !state.templateMode || dismissed) return null;

  const handleDismiss = () => {
    window.sessionStorage.setItem(DISMISSED_KEY, "1");
    setDismissed(true);
  };

  const daName = state.daName || "your DA";
  const cmd = state.interviewCommand || "/interview";

  return (
    <div className="border-b border-blue-500/30 bg-surface-1 backdrop-blur-md">
      <div className="max-w-[1920px] mx-auto px-4 sm:px-6 py-3">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-blue-500/15 p-2 mt-0.5 shrink-0">
            <Sparkles className="w-4 h-4 text-blue-300" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-blue-50">
                You're looking at template content.
              </span>
              <span className="text-sm text-ink-2">
                This is what Pulse looks like before you've made it yours.
              </span>
            </div>
            {/* Each hint is one run of inline text. A flex row here would make
                every bare text node its own flex item, and at narrow widths those
                items shrink and wrap word by word into separate columns. */}
            <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1.5 text-[13px] text-ink-2">
              <p className="min-w-0">
                <MessageSquare className="inline-block w-3.5 h-3.5 mr-1.5 align-[-2px] text-blue-300" />
                Talk to <span className="text-blue-200 font-medium">{daName}</span> — run{" "}
                <code className="px-1.5 py-0.5 rounded bg-surface-3 text-blue-200 text-xs font-mono whitespace-nowrap">
                  {cmd}
                </code>{" "}
                to walk through your TELOS, identity, goals, and projects.
              </p>
              <p className="min-w-0">
                <FolderOpen className="inline-block w-3.5 h-3.5 mr-1.5 align-[-2px] text-blue-300" />
                Or edit{" "}
                <code className="px-1.5 py-0.5 rounded bg-surface-3 text-blue-200 text-xs font-mono whitespace-nowrap">
                  ~/.claude/LIFEOS/USER/
                </code>{" "}
                directly.
              </p>
            </div>
          </div>
          <button
            onClick={handleDismiss}
            aria-label="Hide for this session"
            className="shrink-0 rounded-md text-ink-3 hover:text-ink-1 hover:bg-surface-3 p-1.5 transition-colors"
            title="Hide for this session — banner returns until you customize your USER/ files"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
