import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
} from "react";
import { brandPaths } from "./brand";

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
        {brandPaths.map((d) => <path key={d} d={d} />)}
        <circle cx="157.5" cy="81.5" r="2.8" />
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
