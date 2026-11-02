"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth/client";

export default function SignUpPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();
    setMessage("Creating account...");

    const { error } = await authClient.signUp.email({
      name,
      email,
      password,
    });

    if (error) {
      setMessage(error.message || "Registration failed.");
      return;
    }

    setMessage("Account created successfully!");
  }

  return (
    <main className="mx-auto max-w-md p-8">
      <h1 className="text-2xl font-bold">Create your account</h1>

      <form onSubmit={handleSignUp} className="mt-6 space-y-4">
        <input
          className="w-full rounded border p-3"
          placeholder="Full name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />

        <input
          className="w-full rounded border p-3"
          type="email"
          placeholder="Email address"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />

        <input
          className="w-full rounded border p-3"
          type="password"
          placeholder="Password (minimum 12 characters)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={12}
          required
        />

        <button
          className="w-full rounded bg-stone-900 p-3 text-white"
          type="submit"
        >
          Create account
        </button>
      </form>

      <p className="mt-4 text-sm">{message}</p>
    </main>
  );
}
