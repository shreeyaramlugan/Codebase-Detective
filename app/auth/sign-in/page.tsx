"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth/client";

export default function SignInPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();

    const { error } = await authClient.signIn.email({
      email,
      password,
    });

    if (error) {
      setMessage(error.message || "Sign-in failed.");
      return;
    }

    window.location.href = "/dashboard";
  }

  return (
    <main className="mx-auto max-w-md p-8">
      <h1 className="text-2xl font-bold">Sign in</h1>

      <form onSubmit={handleSignIn} className="mt-6 space-y-4">
        <input
          className="w-full rounded border p-3"
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />

        <input
          className="w-full rounded border p-3"
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />

        <button className="w-full rounded bg-stone-900 p-3 text-white">
          Sign in
        </button>
        <button
  type="button"
  onClick={async () => {
await authClient.signIn.social({
  provider: "github",
  callbackURL: "/dashboard",
});
  }}
  className="w-full rounded border p-3"
>
  Continue with GitHub
</button>
      </form>

      <p className="mt-4 text-sm">{message}</p>
    </main>
  );
}