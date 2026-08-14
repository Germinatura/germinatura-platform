import type { ButtonHTMLAttributes } from "react";

export function Button({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`rounded-lg bg-blue-700 px-4 py-2 font-semibold text-white disabled:opacity-50 ${className}`}
      {...props}
    />
  );
}
