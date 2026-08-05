/** Official-style QRPh mark (BSP / PPMI national QR branding). */
export default function QrphLogo({ className = 'h-9 w-auto' }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 220 64"
      fill="none"
      role="img"
      aria-label="QRPh"
      className={className}
    >
      <rect width="220" height="64" rx="8" fill="#FFFFFF" />
      <g transform="translate(8,8)">
        <path fill="#0033A0" d="M0 0h22v7H7v15H0V0z" />
        <rect x="9.5" y="9.5" width="6" height="6" fill="#0033A0" />
        <path fill="#CE1126" d="M48 48H26v-7h15V26h7v22z" />
        <rect x="32.5" y="32.5" width="6" height="6" fill="#CE1126" />
        <circle cx="24" cy="24" r="8.5" fill="#FCD116" />
      </g>
      <g fontFamily="Arial, Helvetica, sans-serif" fontWeight="800" fontSize="36">
        <text x="72" y="45" fill="#CE1126" letterSpacing="-1">
          QR
        </text>
        <text x="128" y="45" fill="#0033A0" letterSpacing="-1">
          Ph
        </text>
      </g>
    </svg>
  );
}
