// Adapted from https://ui.shadcn.com/r/styles/new-york-v4/progress.json (MIT).
import * as React from "react";
import { Progress as ProgressPrimitive } from "radix-ui";
import { cn } from "../../lib/utils.js";

function Progress({ className, value, max = 100, ...props }: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  const maximum = Number.isFinite(max) && max > 0 ? max : 100;
  const percentage = typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, value / maximum * 100)) : 0;
  return (
    <ProgressPrimitive.Root data-slot="progress" value={value} max={maximum}
      className={cn("relative h-2 w-full overflow-hidden rounded-full bg-primary/20", className)} {...props}>
      <ProgressPrimitive.Indicator data-slot="progress-indicator" className="h-full w-full flex-1 bg-primary transition-all"
        style={{ transform: `translateX(-${100 - percentage}%)` }} />
    </ProgressPrimitive.Root>
  );
}

export { Progress };
