interface BrandMarkProps {
  className?: string;
  title?: string;
}

export function BrandMark({ className = "size-10", title }: BrandMarkProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 48 48"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="48" height="48" rx="12" fill="var(--g-brand-primary)" />
      <path d="M14 13h8v22h-8zM25 13h9l-9 9zM25 25l9-9v9zM25 28h9l-9 9z" fill="white" />
      <circle cx="38" cy="10" r="3" fill="var(--g-accent-aqua)" />
    </svg>
  );
}
