"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/client";

type ProfileEditorProps = {
  name: string;
  email: string;
};

export default function ProfileEditor({ name, email }: ProfileEditorProps) {
  const router = useRouter();

  const [displayName, setDisplayName] = useState(name);
  const [newName, setNewName] = useState(name);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const initials = displayName
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedName = newName.trim();

    setMessage("");
    setError("");

    if (trimmedName.length < 2 || trimmedName.length > 50) {
      setError("Your display name must be between 2 and 50 characters.");
      return;
    }

    if (trimmedName === displayName) {
      setEditing(false);
      return;
    }

    setSaving(true);

    try {
      const result = await authClient.updateUser({
        name: trimmedName,
      });

      if (result.error) {
        setError(result.error.message ?? "Could not update your display name.");
        return;
      }

      setDisplayName(trimmedName);
      setNewName(trimmedName);
      setEditing(false);
      setMessage("Your display name has been updated.");

      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setNewName(displayName);
    setEditing(false);
    setMessage("");
    setError("");
  }

  return (
    <div className="rounded-2xl border border-stone-800 bg-stone-900/70 p-4">
      <div className="flex items-center gap-4">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-orange-500/30 bg-orange-500/10 text-sm font-semibold text-orange-300">
          {initials || "D"}
        </div>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-stone-100">
            {displayName}
          </p>

          <p className="truncate text-xs text-stone-400">{email}</p>

          <p className="mt-1 text-xs text-emerald-400">Authenticated account</p>
        </div>

        {!editing && (
          <button
            type="button"
            onClick={() => {
              setNewName(displayName);
              setEditing(true);
              setMessage("");
              setError("");
            }}
            className="rounded-lg border border-stone-700 px-3 py-2 text-xs font-medium text-stone-300 transition hover:border-orange-500/50 hover:text-orange-300"
          >
            Edit name
          </button>
        )}
      </div>

      {editing && (
        <form onSubmit={handleSave} className="mt-5 space-y-3">
          <label
            htmlFor="displayName"
            className="block text-sm font-medium text-stone-300"
          >
            Display name
          </label>

          <input
            id="displayName"
            type="text"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            maxLength={50}
            minLength={2}
            required
            autoComplete="name"
            className="w-full rounded-lg border border-stone-700 bg-stone-950 px-3 py-2.5 text-sm text-stone-100 outline-none transition placeholder:text-stone-600 focus:border-orange-500"
            placeholder="Enter your display name"
          />

          <p className="text-xs text-stone-500">
            This name will appear in your dashboard greeting and profile.
          </p>

          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-orange-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save changes"}
            </button>

            <button
              type="button"
              onClick={handleCancel}
              disabled={saving}
              className="rounded-lg border border-stone-700 px-4 py-2 text-sm font-medium text-stone-300 transition hover:bg-stone-800 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {message && (
        <p role="status" className="mt-3 text-xs text-emerald-400">
          {message}
        </p>
      )}

      {error && (
        <p role="alert" className="mt-3 text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
