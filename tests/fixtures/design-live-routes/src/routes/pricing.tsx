import { useEffect, useState } from "react";

// The column count follows the same breakpoints as styles.css, so the canvas
// tests can see the page reflow when its frame's viewport changes.
function columns(): number {
  if (matchMedia("(width >= 64rem)").matches) return 3;
  if (matchMedia("(min-width: 768px)").matches) return 2;
  return 1;
}

export default function Pricing() {
  const [layout, setLayout] = useState(() => ({ cols: columns(), width: innerWidth }));
  useEffect(() => {
    const onResize = () => setLayout({ cols: columns(), width: innerWidth });
    addEventListener("resize", onResize);
    return () => removeEventListener("resize", onResize);
  }, []);
  return (
    <main>
      <h1>Pricing</h1>
      <div id="layout" data-cols={layout.cols} data-width={layout.width}>
        <section>Starter</section>
        <section>Team</section>
        <section>Business</section>
      </div>
    </main>
  );
}
