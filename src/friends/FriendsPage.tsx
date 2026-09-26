import { MessageSquare, Search, ShieldCheck, UserPlus, Users, Gamepad2 } from 'lucide-react'
import { Button, Caption, Label } from '@/ui'
import type { Account } from '@/hooks/useAccount'
import { AsciiArt } from '@/ui/ascii/AsciiArt'

const BUBBLE = [
  '╔══════════════════╗',
  '║ ▪▪▪▪▪▪▪▪▪        ║',
  '║ ▪▪▪▪▪▪▪▪▪▪▪▪▪▪   ║',
  '╚═══╗ ╔════════════╝',
  '    ╚═╝',
]

/**
 * Friends & chat - laid out the way it will work (your card, the friends
 * list, the chat pane), with the parts that do not exist yet saying so.
 * The plan is in FRIENDS-AND-CHAT.md at the top of the workspace.
 */
export function FriendsPage({ account, onProfile, onDiscord }: { account: Account; onProfile: () => void; onDiscord: () => void }) {
  const name = account.displayName || account.username
  return (
    <div className="grid min-h-0 grow grid-cols-[300px_1fr]">
      <aside className="grid min-h-0 grid-rows-[auto_auto_1fr] border-r border-border bg-card/40">
        <button
          type="button"
          onClick={onProfile}
          className="kryo-square flex items-center gap-3 border-b border-border p-4 text-left transition-colors hover:bg-secondary"
        >
          {account.avatarUrl ? (
            <img src={account.avatarUrl} alt="" className="kryo-pill size-11 object-cover" />
          ) : (
            <span className="kryo-pill grid size-11 place-items-center bg-secondary text-sm font-bold">{name.slice(0, 1).toUpperCase()}</span>
          )}
          <span className="grid min-w-0">
            <b className="truncate text-sm text-foreground">{name}</b>
            <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-success">
              <span className="size-1.5 rounded-full bg-success" />
              Online
            </span>
          </span>
        </button>
        <div className="flex gap-2 border-b border-border p-3">
          <div className="kryo-pill flex h-8 grow items-center gap-2 border border-border px-3 text-[11px] text-muted-foreground opacity-60">
            <Search className="size-3" />
            Search friends
          </div>
          <Button size="sm" disabled title="Coming soon">
            <UserPlus className="size-3" />
          </Button>
        </div>
        <div className="grid content-start gap-5 overflow-auto p-4">
          <Group title="Friends" />
          <Group title="Online" />
          <Group title="Group chats" />
        </div>
      </aside>

      <section className="grid min-h-0 place-content-center justify-items-center gap-6 overflow-auto p-10 text-center">
        <AsciiArt lines={BUBBLE} mode="reveal" revealMs={700} className="h-24 text-muted-foreground" />
        <div className="grid gap-2">
          <Label>Friends &amp; chat</Label>
          <p className="text-2xl font-bold text-foreground">Coming soon</p>
        </div>
        <ul className="grid w-full max-w-md gap-2 text-left">
          <Plan icon={<Users />} title="Friends" body="Add people from their kryo.to profile and see who is online." />
          <Plan icon={<MessageSquare />} title="Chat" body="Direct messages, and one public room for everyone." />
          <Plan icon={<Gamepad2 />} title="Game invites" body="See what friends are playing and invite them to yours." />
          <Plan icon={<ShieldCheck />} title="Safety" body="Block anyone, and report a message straight to staff." />
        </ul>
        <Button onClick={onDiscord}>Talk on Discord for now</Button>
      </section>
    </div>
  )
}

function Group({ title }: { title: string }) {
  return (
    <div className="grid gap-2">
      <Caption className="flex items-center justify-between">
        <span>{title}</span>
        <span>0</span>
      </Caption>
      <p className="kryo-radius border border-dashed border-border px-3 py-2.5 text-[11px] text-muted-foreground">Nobody here yet</p>
    </div>
  )
}

function Plan({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <li className="kryo-radius flex items-start gap-3 border border-border bg-card p-3">
      <span className="mt-0.5 text-muted-foreground [&>svg]:size-4">{icon}</span>
      <span className="grid gap-0.5">
        <b className="text-xs text-foreground">{title}</b>
        <span className="text-xs text-muted-foreground">{body}</span>
      </span>
    </li>
  )
}
