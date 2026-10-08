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

/** Ids of a field's helper texts, for `aria-describedby` on the control. */
export function fieldDescriptionIds(id: string, { description, error }: { description?: string; error?: string }) {
  return [description && !error ? `${id}-description` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
}

export function Field({ id, label, description, error, children, className }: FieldProps) {
  return (
    <div className={joinClassNames("g-field", className)}>
      <label className="g-label" htmlFor={id}>{label}</label>
      {children}
      {description && !error && <p className="g-field__description" id={`${id}-description`}>{description}</p>}
      {error && <p className="g-field__error" id={`${id}-error`} role="alert">{error}</p>}
    </div>
  );
}

interface InputGroupProps {
  /** Decorative icon shown inside the field, before the text. It never receives clicks: the input does. */
  icon: ReactNode;
  /** Optional control at the end of the field (for example, show or hide a password). */
  trailing?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * An input with a leading decorative icon. The input's start padding comes from the group, so the icon never covers
 * the text or the placeholder at any zoom; pass a `.g-input` (Input) as the child.
 */
export function InputGroup({ icon, trailing, children, className }: InputGroupProps) {
  return (
    <div className={joinClassNames("g-input-group", trailing ? "g-input-group--trailing" : undefined, className)}>
      <span className="g-input-group__icon" aria-hidden="true">{icon}</span>
      {children}
      {trailing && <span className="g-input-group__trailing">{trailing}</span>}
    </div>
  );
}

interface ReasonFieldProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** Smallest accepted length after trimming, as the server requires it. */
  minLength: number;
  maxLength: number;
  label?: string;
  /** What the reason is for, shown before the length rule. */
  description?: string;
  multiline?: boolean;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
  className?: string;
}

/**
 * A reason for an audited action. The minimum length is always written next to the field, and while the text is
 * shorter the field says how far it is, so a disabled button is never the only explanation.
 */
export function ReasonField({ id, value, onChange, minLength, maxLength, label = "Motivo", description, multiline, disabled, required, placeholder, className }: ReasonFieldProps) {
  const length = value.trim().length;
  const short = length > 0 && length < minLength;
  const rule = `Mínimo de ${minLength} caracteres.`;
  const control = {
    id, value, disabled, required, placeholder, maxLength, className: "g-input",
    "aria-describedby": `${id}-rule ${id}-count`,
    "aria-invalid": short || undefined,
  };
  return (
    <div className={joinClassNames("g-field", className)}>
      <label className="g-label" htmlFor={id}>{label}</label>
      {multiline
        ? <textarea {...control} rows={3} onChange={(event) => onChange(event.target.value)} />
        : <input {...control} onChange={(event) => onChange(event.target.value)} />}
      <p className="g-field__description" id={`${id}-rule`}>{description ? `${description} ` : ""}{rule}</p>
      <p className={joinClassNames("g-field__description", short ? "g-field__description--warning" : undefined)} id={`${id}-count`} aria-live="polite">
        {length < minLength ? `${length}/${minLength} caracteres` : ""}
      </p>
    </div>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={joinClassNames("g-input", className)} {...props} />;
}
