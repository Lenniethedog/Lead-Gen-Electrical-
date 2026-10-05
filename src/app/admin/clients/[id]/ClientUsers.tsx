import { CLIENT_USER_ROLES, CLIENT_USER_ROLE_LABELS } from "@/config/client-auth";
import type { ClientUserRecord } from "@/modules/clientauth";
import { cardClass, hintClass, inputClass, labelClass, primaryButton, secondaryButton } from "../../_components/styles";
import { formatShort } from "../../_format";
import { inviteUserAction, resendUserLinkAction, setUserDisabledAction, setUserRoleAction } from "../actions";

const STATUS_TEXT = { invited: "Invited, not signed in yet", active: "Active", disabled: "Disabled" } as const;

/** The people who may sign in to this business's dashboard. Staff invite them; they sign in with an emailed link (no password). */
export function ClientUsers({ clientId, users }: { clientId: string; users: ClientUserRecord[] }) {
  return (
    <section id="people" aria-labelledby="people-heading" className={`${cardClass} mt-6`}>
      <h2 id="people-heading" className="text-xl font-bold text-ink">People who can sign in</h2>
      <p className={`mt-1 max-w-3xl ${hintClass}`}>
        They sign in at <span className="font-mono">/dashboard</span> with a link we email them, and see only this business&rsquo;s leads. An email address can belong to one business. Disabling someone signs them out everywhere at once.
      </p>

      {users.length === 0 ? (
        <p className="mt-4">Nobody can sign in yet.</p>
      ) : (
        <ul className="mt-4 divide-y divide-stone-200">
          {users.map((user) => (
            <li key={user.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div>
                <div className="font-semibold text-ink">{user.name}</div>
                <div className="text-sm text-muted">{user.email} · {STATUS_TEXT[user.status]}{user.lastLoginAt ? ` · last signed in ${formatShort(user.lastLoginAt)}` : ""}</div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <form action={setUserRoleAction} className="flex items-center gap-2">
                  <input type="hidden" name="userId" value={user.id} />
                  <label htmlFor={`role-${user.id}`} className="sr-only">Role for {user.name}</label>
                  <select id={`role-${user.id}`} name="role" defaultValue={user.role} className={`${inputClass} !min-h-10 !w-auto !text-base`}>
                    {CLIENT_USER_ROLES.map((role) => <option key={role} value={role}>{CLIENT_USER_ROLE_LABELS[role]}</option>)}
                  </select>
                  <button type="submit" className={`${secondaryButton} !min-h-10 !px-3 !py-1 !text-base`}>Change role</button>
                </form>
                {user.status !== "disabled" && (
                  <form action={resendUserLinkAction}>
                    <input type="hidden" name="userId" value={user.id} />
                    <button type="submit" className={`${secondaryButton} !min-h-10 !px-3 !py-1 !text-base`}>Email a new link</button>
                  </form>
                )}
                <form action={setUserDisabledAction}>
                  <input type="hidden" name="userId" value={user.id} />
                  <input type="hidden" name="disabled" value={user.status === "disabled" ? "false" : "true"} />
                  <button type="submit" className={`${secondaryButton} !min-h-10 !px-3 !py-1 !text-base`}>{user.status === "disabled" ? "Enable" : "Disable"}</button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h3 className="mt-6 text-lg font-bold text-ink">Invite someone</h3>
      <form action={inviteUserAction} className="mt-2 grid gap-3 sm:grid-cols-2">
        <input type="hidden" name="clientId" value={clientId} />
        <div>
          <label htmlFor="user-name" className={labelClass}>Name</label>
          <input id="user-name" name="name" required maxLength={120} autoComplete="off" className={inputClass} />
        </div>
        <div>
          <label htmlFor="user-email" className={labelClass}>Work email</label>
          <input id="user-email" name="email" type="email" required maxLength={254} autoComplete="off" className={inputClass} />
        </div>
        <div>
          <label htmlFor="user-role" className={labelClass}>Role</label>
          <select id="user-role" name="role" defaultValue="manager" className={inputClass}>
            {CLIENT_USER_ROLES.map((role) => <option key={role} value={role}>{CLIENT_USER_ROLE_LABELS[role]}</option>)}
          </select>
        </div>
        <div className="flex items-end">
          <button type="submit" className={primaryButton}>Invite and email a link</button>
        </div>
      </form>
      <p className={`mt-2 ${hintClass}`}>Be sure the address is right: whoever receives the link can see this business&rsquo;s leads. No password is ever set.</p>
    </section>
  );
}
