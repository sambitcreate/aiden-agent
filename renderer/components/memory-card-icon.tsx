import type { SVGProps } from "react";

/** SD-card silhouette, using the same stroke and sizing as the app's Lucide icons. */
export function MemoryCardIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M7 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a2 2 0 0 1 2-2Z" />
      <path d="M8 3v5m3-5v5m3-5v5M8 14h8v4H8z" />
    </svg>
  );
}
