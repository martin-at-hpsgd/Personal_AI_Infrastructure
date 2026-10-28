"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { ObserverModeProvider } from "@/contexts/ObserverModeContext";
import { makeQueryClient } from "@/lib/query-client";
import { PrincipalTzSync } from "@/lib/principal-tz-sync";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(makeQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <ObserverModeProvider><PrincipalTzSync>{children}</PrincipalTzSync></ObserverModeProvider>
    </QueryClientProvider>
  );
}
