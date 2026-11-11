interface BrandLogoProps {
  size?: number;
  color?: string;
}

export default function BrandLogo({ size = 40, color = 'currentColor' }: BrandLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      {/* 数据圆柱 */}
      <ellipse cx="20" cy="11" rx="12" ry="5" stroke={color} strokeWidth="2.5" />
      <path
        d="M8 11v14c0 2.76 5.37 5 12 5s12-2.24 12-5V11"
        stroke={color}
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <path
        d="M8 18.5c0 2.76 5.37 5 12 5s12-2.24 12-5"
        stroke={color}
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      {/* 安全盾牌 */}
      <path
        d="M28 28c0-1.1.89-2 1.98-2h8.04c1.09 0 1.98.9 1.98 2v2.5c0 3.6-2.7 7.1-6 8.5-3.3-1.4-6-4.9-6-8.5V28Z"
        fill={color}
        fillOpacity="0.12"
        stroke={color}
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <path
        d="M33 30.5l2.5 2.5L39 27.5"
        stroke={color}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
