'use client';

import AppShell from '@/components/AppShell';

// One static route; the views live in location.hash (see lib/router.ts, lib/nav.ts).
export default function Page() {
  return <AppShell />;
}
