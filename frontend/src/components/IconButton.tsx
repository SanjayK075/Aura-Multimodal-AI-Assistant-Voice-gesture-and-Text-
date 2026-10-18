import type { ButtonHTMLAttributes, ReactNode } from "react";

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "title"> {
  /** What the button does. Shown as a tooltip and read by screen readers. */
  label: string;
  /** For on/off buttons: whether it is currently on. */
  pressed?: boolean;
  children: ReactNode;
}

/** A square button that shows only an icon. */
export function IconButton({ label, pressed, children, className = "", ...rest }: Props) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`.trim()}
      aria-label={label}
      aria-pressed={pressed}
      data-tip={label}
      {...rest}
    >
      {children}
    </button>
  );
}
