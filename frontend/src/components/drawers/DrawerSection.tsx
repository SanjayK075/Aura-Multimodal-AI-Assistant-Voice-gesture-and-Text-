import type { ReactNode } from "react";

/** A titled group inside a drawer. */
export function DrawerSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="drawer-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}
