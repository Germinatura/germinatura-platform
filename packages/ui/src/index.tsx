import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
} from "react";

interface BrandMarkProps {
  className?: string;
  title?: string;
  tone?: "brand" | "inverse";
}

/**
 * Official Germinatura mark supplied in the institutional SVG pack.
 * Keep this geometry centralized: applications choose only the surface tone.
 */
export function BrandMark({ className = "size-10", title, tone = "brand" }: BrandMarkProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 200 200"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      xmlns="http://www.w3.org/2000/svg"
    >
      <g fill={tone === "inverse" ? "currentColor" : "#0E208E"}>
        <path d="M50 38 108 24 170 51 143 59 C132 51 118 46 103 43 C91 41 82 43 75 48 L74 56 Z" />
        <path d="M78 50 C94 43 119 47 140 59 L140 78 C124 70 110 65 99 64 H74 C74 58 75 53 78 50 Z" />
        <path d="M58 82 H94 V118 H58 Z" />
        <path d="M103 82 H139 V116 Z" />
        <path d="M58 127 H94 C94 143 85 154 75 159 C69 162 64 163 58 163 Z" />
        <path d="M157 56 H158 V79 H157 Z" />
        <circle cx="157.5" cy="81.5" r="2.8" />
        <path d="M157 84 C156.5 89 155.2 93 154 97 C154.6 100 160.4 100 161 97 C159.8 93 158.5 89 158 84 Z" />
      </g>
    </svg>
  );
}

function joinClassNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export type ButtonVariant =
  | "brand"
  | "operation"
  | "secondary"
  | "ghost"
  | "danger";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  loading?: boolean;
}

export function Button({
  className,
  variant = "brand",
  size = "md",
  loading = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={joinClassNames(
        "g-button",
        `g-button--${variant}`,
        `g-button--${size}`,
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <span className="g-spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  tone?: "default" | "subtle" | "selected";
}

export function Card({ className, tone = "default", ...props }: CardProps) {
  return (
    <div
      className={joinClassNames("g-card", `g-card--${tone}`, className)}
      {...props}
    />
  );
}

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: "neutral" | "info" | "success" | "warning" | "danger";
}

export function Badge({ className, tone = "neutral", ...props }: BadgeProps) {
  return (
    <span
      className={joinClassNames("g-badge", `g-badge--${tone}`, className)}
      {...props}
    />
  );
}

interface FieldProps {
  id: string;
  label: string;
  description?: string;
  error?: string;
  children: ReactNode;
  className?: string;
}

export function Field({ id, label, description, error, children, className }: FieldProps) {
  return (
    <div className={joinClassNames("g-field", className)}>
      <label className="g-label" htmlFor={id}>{label}</label>
      {children}
      {description && !error && <p className="g-field__description">{description}</p>}
      {error && <p className="g-field__error" id={`${id}-error`} role="alert">{error}</p>}
    </div>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={joinClassNames("g-input", className)} {...props} />;
}
