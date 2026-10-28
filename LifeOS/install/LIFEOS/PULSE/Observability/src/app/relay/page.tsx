"use client";

import { MessageSquare } from "lucide-react";
import { PageShell, PageHeader } from "@/components/ui/chrome";
import RelayStatusCard from "@/components/RelayStatusCard";

export default function RelayPage() {
  return (
    <PageShell>
      <PageHeader icon={MessageSquare} title="Relay" subtitle="Texting the DA over iMessage: the bridge, the guard, and the lock" />
      <RelayStatusCard />
    </PageShell>
  );
}
