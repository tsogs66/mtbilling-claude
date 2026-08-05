/** Official-style QRPh mark (BSP / PPMI national QR branding). Transparent background. */
export default function QrphLogo({ className = 'h-9 w-auto' }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 200 56"
      fill="none"
      role="img"
      aria-label="QRPh"
      className={className}
    >
      <g transform="translate(2,4)">
        <path fill="#0033A0" d="M0 0h20v6.5H6.5V20H0V0z" />
        <rect x="8.5" y="8.5" width="5.5" height="5.5" fill="#0033A0" />
        <path fill="#CE1126" d="M44 44H24v-6.5h13.5V24H44v20z" />
        <rect x="30" y="30" width="5.5" height="5.5" fill="#CE1126" />
        <circle cx="22" cy="22" r="8" fill="#FCD116" />
      </g>
      <g fontFamily="Arial, Helvetica, sans-serif" fontWeight="800" fontSize="32">
        <text x="58" y="40" fill="#CE1126" letterSpacing="-1">
          QR
        </text>
        <text x="108" y="40" fill="#FFFFFF" letterSpacing="-1">
          Ph
        </text>
      </g>
    </svg>
  );
}
