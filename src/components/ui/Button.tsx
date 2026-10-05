import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary";

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  variant?: Variant;
  fullWidth?: boolean;
}

const base =
  "inline-flex min-h-12 items-center justify-center gap-2 rounded-lg px-6 py-3 text-lg font-semibold focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300 disabled:cursor-not-allowed";

const variants: Record<Variant, string> = {
  primary: "bg-brand-700 text-white hover:bg-brand-800 disabled:bg-stone-500",
  secondary: "border-2 border-stone-400 bg-white text-ink hover:border-stone-600 disabled:text-stone-500",
};

export function Button({ variant = "primary", fullWidth = false, type = "button", ...props }: ButtonProps) {
  return <button type={type} className={`${base} ${variants[variant]} ${fullWidth ? "w-full" : ""}`} {...props} />;
}
