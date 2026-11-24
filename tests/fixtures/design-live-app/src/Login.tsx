import { useEffect, useState } from "react";

export function Login() {
  const [me, setMe] = useState("…");
  useEffect(() => {
    fetch("/api/me", { credentials: "same-origin" })
      .then((response) => (response.ok ? response.text() : "signed out"))
      .then(setMe, () => setMe("error"));
  }, []);
  return (
    <main>
      <h1>Sign in</h1>
      <p id="me">{me}</p>
      <form id="login-form" method="post" action="/api/login">
        <input name="user" defaultValue="fixture" />
        <button id="login-submit" type="submit">Sign in</button>
      </form>
    </main>
  );
}
