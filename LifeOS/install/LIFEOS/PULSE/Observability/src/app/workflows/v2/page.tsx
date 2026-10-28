"use client";

import { useEffect } from "react";

// /workflows/v2 was the Cue-style page while it ran beside V1. It is now
// /workflows; this keeps old links (and their query strings) working.
export default function WorkflowsV2Redirect() {
  useEffect(() => {
    window.location.replace(`/workflows${window.location.search}`);
  }, []);
  return null;
}
