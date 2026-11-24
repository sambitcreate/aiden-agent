import { useState } from "react";

export function Home() {
  const [count, setCount] = useState(0);
  return (
    <main>
      <h1 id="home-title">Fixture home</h1>
      <button id="counter" type="button" onClick={() => setCount((value) => value + 1)}>
        Count {count}
      </button>
      <p>
        <a id="to-pricing" href="/pricing">Pricing</a> · <a id="to-login" href="/go-login">Sign in</a> ·{" "}
        <a id="to-out" href="/go-out">Out</a> · <a id="to-framed" href="/framed">Framed</a>
      </p>
    </main>
  );
}
