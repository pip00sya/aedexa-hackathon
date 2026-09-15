/** AEDEXA mark */

type MarkProps = {
  /** Mark side length in pixels */
  size?: number;
  /** Extra class for positioning */
  className?: string;
};

export default function Mark({ size = 34, className }: MarkProps) {
  return (
    <svg
      className={className ? `aedexa-glyph ${className}` : "aedexa-glyph"}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="currentColor"
      role="img"
      aria-label="AEDEXA"
    >
      {/* Left face turns toward the light */}
      <path d="M16 3 3 27l13-8z" />
      {/* Right face turns away */}
      <path d="M16 3 29 27l-13-8z" opacity="0.8" />
      {/* Bottom face sits in shadow */}
      <path d="M3 27h26l-13-8z" opacity="0.58" />
    </svg>
  );
}
