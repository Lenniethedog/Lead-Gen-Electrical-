import type { Metadata } from "next";
import Link from "next/link";
import { loadOperatorEmail } from "@/server/admin/inbox";
import { cardClass, linkClass } from "../../_components/styles";
import { ClientForm } from "../ClientForm";
import { createClientAction } from "../actions";

export const metadata: Metadata = { title: "New client" };

export default async function NewClientPage() {
  await loadOperatorEmail(); // authenticate before rendering anything
  return (
    <>
      <p>
        <Link href="/admin/clients" className={linkClass}>
          &larr; All clients
        </Link>
      </p>
      <h1 className="mt-3 text-2xl font-extrabold text-ink">New client</h1>
      <p className="mt-2 text-muted">A new client starts as a prospect. Add what they do and where they cover, then make them active.</p>
      <div className={`${cardClass} mt-4`}>
        <ClientForm action={createClientAction} submitLabel="Create client" />
      </div>
    </>
  );
}
