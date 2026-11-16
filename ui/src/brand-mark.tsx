import type { InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import { BRAND_CHECK, BRAND_FRAME, BRAND_LIME, BRAND_PURPLE } from "./brand-geometry";

export function BrandMark({ size = 24, className, tone = "theme" }: {
  size?: number;
  className?: string;
  tone?: "theme" | "brand";
}) {
  const frame = tone === "brand" ? BRAND_PURPLE : "var(--completion-frame)";
  const check = tone === "brand" ? BRAND_LIME : "var(--completion-check)";
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="none" className={cn("shrink-0", className)} aria-hidden="true" focusable="false" strokeLinecap="round" strokeLinejoin="round">
      <path d={BRAND_FRAME} stroke={frame} strokeWidth="40" />
      <path d={BRAND_CHECK} stroke={frame} strokeWidth="64" />
      <path d={BRAND_CHECK} stroke={check} strokeWidth="36" />
    </svg>
  );
}

type CompletionCheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "size"> & { size?: number };

export function CompletionCheckbox({ size = 20, className, disabled, ...props }: CompletionCheckboxProps) {
  return (
    <span className={cn("relative inline-flex shrink-0 align-middle", disabled && "opacity-40", className)} style={{ width: size, height: size }}>
      <input {...props} disabled={disabled} type="checkbox" className="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed" />
      <span aria-hidden="true" className="pointer-events-none absolute inset-[2px] rounded-[5px] border-[1.5px] border-white/40 peer-checked:hidden" />
      <span className="pointer-events-none hidden peer-checked:block"><BrandMark size={size} /></span>
      <span aria-hidden="true" className="pointer-events-none absolute -inset-1 rounded-md peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-orange-500" />
    </span>
  );
}
