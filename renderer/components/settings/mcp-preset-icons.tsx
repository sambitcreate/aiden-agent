// Brand logomarks for built-in MCP presets. Paths are adapted from each
// vendor's public brand assets (Composio Brand Hub logomark; Notion and Linear
// from Simple Icons / official marks) and rendered with currentColor so they
// follow light/dark text tokens.

import * as React from "react";

type IconProps = React.SVGProps<SVGSVGElement>;

function ComposioIcon({ className, ...props }: IconProps) {
  const clipId = React.useId();
  return (
    <svg viewBox="0 0 100 100" fill="none" aria-hidden className={className} {...props}>
      <g clipPath={`url(#${clipId})`}>
        <path
          d="M91.7032 28.1801L35.3611 16.6572C31.6669 15.8988 28.1929 18.7367 28.1929 22.5043V49.1954V50.6144V77.3052C28.1929 81.0729 31.6669 83.9112 35.3611 83.1526L91.7032 71.6296"
          stroke="currentColor"
          strokeWidth="2.8556"
          strokeMiterlimit="10"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M48.1992 7.38531C48.1993 2.09223 53.6097 -1.44765 58.4546 0.57874L58.6851 0.679333L58.6902 0.68227L88.8308 14.6023C91.4759 15.7947 93.1338 18.4366 93.1346 21.3053V33.0975C93.1346 37.3994 89.4707 40.797 85.1902 40.4658L51.0547 37.918V61.8914L85.185 59.3435L85.585 59.323C89.6842 59.2231 93.1331 62.5334 93.109 66.6876V78.4797C93.109 81.3707 91.4075 83.9737 88.8105 85.1812L88.806 85.1827L58.691 99.0774L58.6917 99.0782C53.7808 101.351 48.1992 97.7714 48.1992 92.3759V81.1383C47.9779 81.2256 47.741 81.2834 47.4921 81.3015L30.8347 82.5007C29.4429 82.6007 28.2584 81.4977 28.2582 80.1023V67.7354C28.2583 67.256 28.4014 66.8063 28.6474 66.4277L14.9439 67.4513H14.9388C10.6701 67.7539 7.00001 64.3671 7 60.0823V39.7271C7.00031 35.4239 10.6671 32.0248 14.9491 32.3589H14.9483L28.3486 33.3589C28.2905 33.152 28.2583 32.9345 28.2582 32.7099V19.6826C28.2582 17.7807 29.9597 16.3299 31.8377 16.6304L47.6992 19.168C47.8735 19.1959 48.0404 19.2435 48.1992 19.3059V7.38531ZM85.4075 62.191H85.4023L51.0547 64.755V79.6601L90.2541 71.4669V66.6774L90.2496 66.435C90.1323 63.9438 87.9489 61.9928 85.4075 62.191ZM27.7075 36.1748C27.9471 36.5495 28.0863 36.9936 28.0864 37.4678V62.7813C28.0864 63.0748 28.0314 63.3559 27.9344 63.6169L48.1992 62.1044V37.7043L27.7075 36.1748ZM51.0547 35.0544L85.4023 37.6183L85.4075 37.6191L85.6511 37.6316C88.1632 37.6928 90.279 35.6595 90.279 33.0975V28.1405L51.0547 19.9411V35.0544Z"
          fill="currentColor"
        />
      </g>
      <defs>
        <clipPath id={clipId}>
          <rect width="86.4662" height="100" fill="white" transform="translate(7)" />
        </clipPath>
      </defs>
    </svg>
  );
}

function NotionIcon({ className, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className} {...props}>
      <path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z" />
    </svg>
  );
}

function LinearIcon({ className, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className} {...props}>
      <path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z" />
    </svg>
  );
}

const PRESET_ICONS: Record<string, React.ComponentType<IconProps>> = {
  composio: ComposioIcon,
  notion: NotionIcon,
  linear: LinearIcon,
};

/** Brand mark for a catalog preset id; falls back to the name initial. */
export function McpPresetIcon({
  presetId,
  name,
  className,
}: {
  presetId: string;
  name: string;
  className?: string;
}) {
  const Icon = PRESET_ICONS[presetId];
  if (!Icon) {
    return (
      <span aria-hidden className={className}>
        {name.charAt(0)}
      </span>
    );
  }
  return <Icon className={className} />;
}
