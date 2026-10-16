// SI7b: spend insights in the Assistant. Home puts these into the designer's slots of Assistant:
// `composerExtra` (the movement attached to the next message), `messageExtra` (the attachment on
// a user message; cited movements and quick replies on an assistant message) and `suggestions`.
// The data is `extras` of each message of GET /api/conversations/:id (contracts.md §3 and §4);
// bank text (`title`) is always rendered as text.
import type {
  AttachedMovement as Movement,
  GoalCreated,
  GoalPlan,
  MessageExtras,
} from '../../src/agent/extras';
import { mainAccount } from '../../src/banking/recipients';
import { categoryLabel, type RowCategory } from '../../src/insights/taxonomy';
import type { OfferCard, OfferExtras, OfferSheet } from '../../src/offers/catalogue';
import { formatDate, money, parseMessage, type AnyRecord } from '../../src/ui-helpers';
import { Icon } from './Icon';
import { PlanPreview } from './plan/Goals';
import { dayYear, eur, PREPARED_LINE } from './plan/logic';

// What "Ask about my spending" sends, and the first suggestion.
export const ASK_SPENDING = 'Where did my money go?';
// AS1: the suggestions that depend on what the customer holds, shared by the Assistant and the
// Overview's Assistant card. A fixed "Aurora account" question was shown to customers without
// one. Every product has a documented fee (only Aurora has a waiver), so the fee question is true
// for any main account. With no account there is nothing to ask about: neither is offered.
export const accountSuggestions = (accounts: { label?: string }[]) => {
  const label = mainAccount(accounts)?.label;
  return [
    ...(accounts.length === 1
      ? ['What is the balance of my account?']
      : accounts.length
        ? ['What are the balances of my accounts?']
        : []),
    ...(label ? [`What is the fee of my ${label}?`] : []),
  ];
};
// The Assistant's list for this customer (its `suggestions` prop replaces the built-in one).
// A24f: it starts with the Overview card's three, in the card's order.
export const chatSuggestions = (accounts: { label?: string }[]) => [
  ASK_SPENDING,
  ...accountSuggestions(accounts),
  'I want to speak to a person',
];

// What "Ask the assistant" sends about a movement.
export const askText = (c: Pick<RowCategory, 'id' | 'state'>) =>
  c.state === 'estimated' || c.state === 'confirmed'
    ? `Why is this ${categoryLabel(c.id)}?`
    : 'Help me categorise this movement.';

// REQ-SI7-8: in the composer (with `onRemove`) it goes with the next message; on a user message
// it is the movement that message was about.
export function AttachedMovement({
  movement: m,
  onRemove,
}: {
  movement: Movement;
  onRemove?: () => void;
}) {
  return (
    <span className="si-chat si-attached" data-testid="attached-movement" data-movement-id={m.id}>
      <span className="si-attached-icon" aria-hidden="true">
        <Icon name="transfer" size={13} />
      </span>
      <span className="si-attached-main">
        <span className="sr-only">Attached movement: </span>
        <strong>{m.title}</strong>
        <span className="si-sub">{`${formatDate(m.createdAt, false)} · ${money(m.amountCents)}`}</span>
      </span>
      {onRemove && (
        <button
          type="button"
          className="si-remove"
          aria-label="Remove the attached movement"
          onClick={onRemove}
        >
          <Icon name="close" size={12} />
        </button>
      )}
    </span>
  );
}

// REQ-SI7-9: a click sends the reply's value unchanged (the server recognises it by exact match
// and knows the movement it is about, so no movement id goes with it).
export function QuickReplies({
  replies,
  disabled,
  onSend,
}: {
  replies: NonNullable<MessageExtras['quickReplies']>;
  disabled: boolean;
  onSend(value: string): void;
}) {
  return (
    <div className="si-chat si-replies" role="group" aria-label="Quick replies">
      {replies.map((r) => (
        <button
          type="button"
          key={r.value}
          className="si-reply"
          data-testid="quick-reply"
          disabled={disabled}
          onClick={() => onSend(r.value)}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

function CitedMovements({
  movements,
}: {
  movements: NonNullable<MessageExtras['citedMovements']>;
}) {
  return (
    <div className="si-chat si-cited">
      <span className="si-caption">Movements in this answer</span>
      <ul aria-label="Movements in this answer">
        {movements.map((m) => (
          <li key={m.id} data-testid="cited-movement" data-movement-id={m.id}>
            <span className="si-cited-main">
              <strong>{m.title}</strong>
              <span className="si-sub">{`${formatDate(m.createdAt, false)} · ${categoryLabel(m.category)}`}</span>
            </span>
            <span className="si-cited-amount">{money(m.amountCents)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// XS4 (plan 24 §6): one product sheet, closed until asked for. Its text is the offer's Markdown
// file: the `# title` line is dropped (the block or the answer already names the product) and a
// `## section` line becomes a bold line; `parseMessage` gives data, so it is never HTML.
function ProductSheet({ sheet }: { sheet: OfferSheet }) {
  const text = sheet.text.replace(/^# .*\n/, '').replace(/^## (.+)$/gm, '**$1**');
  const line = (parts: { kind: string; text: string }[]) =>
    parts.map((p, i) => (p.kind === 'strong' ? <strong key={i}>{p.text}</strong> : p.text));
  return (
    <details className="offer-sheet" data-testid="offer-sheet" data-offer-id={sheet.id}>
      <summary>{`Product sheet · v${sheet.version} · demonstration content`}</summary>
      <div className="offer-sheet-text">
        {parseMessage(text).map((b, i) =>
          b.kind === 'p' ? (
            <p key={i}>{line(b.inlines)}</p>
          ) : (
            <ul key={i}>
              {b.items.map((item, j) => (
                <li key={j}>{line(item)}</li>
              ))}
            </ul>
          ),
        )}
      </div>
    </details>
  );
}

// XS4 (REQ-XS-20): the product suggestion under an answer. Everything shown is server text
// (`extras.offer`, `extras.offerSources`); with sheets and no offer (the "Tell me more" answer)
// only the sheets are shown. The replies of the message sit inside the block.
function OfferBlock({
  offer,
  sheets,
  replies,
}: {
  offer?: OfferCard;
  sheets: OfferSheet[];
  replies: React.ReactNode;
}) {
  return (
    <aside
      className="si-chat offer-block"
      aria-label="Product suggestion"
      data-testid={offer && 'offer-card'}
      data-offer-id={offer?.id}
    >
      {offer && (
        <>
          <p className="offer-eyebrow">Suggestion</p>
          <p className="offer-name">
            <strong>{offer.name}</strong>
          </p>
          <p>{offer.text}</p>
          <p className="offer-basis" data-testid="offer-basis">
            {`Why you see this: ${offer.basis}`}
          </p>
        </>
      )}
      {sheets.map((s) => (
        <ProductSheet key={s.id} sheet={s} />
      ))}
      {offer && <p className="offer-note">Nothing is contracted in this chat.</p>}
      {replies}
    </aside>
  );
}

// UI4: the plan the assistant worked out, under its answer. Every figure is `extras.goalPlan`
// (the server's dry run), none is read from the answer's prose; the block is the form's own
// preview. The name is the customer's free text: text only. No button here: "Create this goal"
// and "Change something" are the message's ordinary quick replies. `created`: the customer then
// created it (see `createdPlans`); the card settles and says so, its figures unchanged.
function GoalPlanCard({ plan, created }: { plan: GoalPlan; created: boolean }) {
  return (
    <section
      className={`si-chat chat-goal${created ? ' settled' : ''}`}
      aria-label="Savings goal plan"
      data-testid="chat-goal-plan"
      data-created={created || undefined}
    >
      <div className="chat-goal-head">
        <p className="chat-goal-name">
          <bdi>{plan.name}</bdi>
        </p>
        {created && (
          <span className="chat-goal-chip">
            <Icon name="check" size={12} />
            Created
          </span>
        )}
      </div>
      <p className="chat-goal-target">
        {`${eur(plan.targetCents)} by ${dayYear(plan.targetDate, plan.today)}`}
      </p>
      <p className="chat-goal-route">
        {`${plan.from.label} → ${plan.to.label} · day ${plan.day} of each month`}
      </p>
      <PlanPreview
        plan={plan}
        targetCents={plan.targetCents}
        targetDate={plan.targetDate}
        today={plan.today}
        room={plan.room}
        live={false}
      />
    </section>
  );
}

// UI4: the goal `create_goal` created (GL3: with its target and the day it was created). Nothing
// was sent: the fixed line of §6.1 says so.
function GoalCreatedBlock({ goal, onOpen }: { goal: GoalCreated; onOpen?: (id: string) => void }) {
  return (
    <section
      className="si-chat chat-goal created"
      aria-label="Savings goal created"
      data-testid="chat-goal-created"
    >
      <p className="chat-goal-name">
        <bdi>{goal.name}</bdi>
      </p>
      <p className="chat-goal-target">
        {`${eur(goal.targetCents)} by ${dayYear(goal.targetDate, goal.today)}`}
      </p>
      <p className="chat-goal-target">
        {`${eur(goal.monthlyCents)} a month · first on ${dayYear(goal.firstDue, goal.today)}`}
      </p>
      <p className="chat-goal-note">{PREPARED_LINE}</p>
      {onOpen && (
        <button type="button" className="plan-link" onClick={() => onOpen(goal.id)}>
          See it in Plan
        </button>
      )}
    </section>
  );
}

// UI4 follow-up: the ids of the plan messages the customer then created. A creation (an assistant
// message with `goalCreated`) answers the assistant message right before it, the customer's own
// messages skipped; only that one is marked, and only when it carried a plan.
export function createdPlans(messages: AnyRecord[]) {
  const ids = new Set<string>();
  let previous: AnyRecord | null = null;
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    const x: MessageExtras | null = m.extras ?? null;
    if (
      x?.goalCreated &&
      !x.turnFailed &&
      previous?.extras?.goalPlan &&
      !previous.extras.turnFailed
    )
      ids.add(previous.id);
    previous = m;
  }
  return ids;
}

// The `messageExtra` slot. `newest`: `m` is the conversation's newest assistant message, the only
// one whose replies the server still accepts. `busy`: a turn is in flight (a second send would
// get a 409), so the replies stay in place, disabled. Null when there is nothing to add: Assistant
// then renders the message exactly as before.
export function messageExtras(
  m: AnyRecord,
  {
    newest,
    busy,
    onReply,
    onOpenGoal,
    planCreated = false,
  }: {
    newest: boolean;
    busy: boolean;
    onReply(value: string): void;
    // UI4: opens one goal in the Plan tab.
    onOpenGoal?: (id: string) => void;
    // UI4 follow-up: this message's plan was then created (`createdPlans`).
    planCreated?: boolean;
  },
) {
  // XS3 adds `OfferExtras` to `MessageExtras`; the intersection is then a no-op.
  const extras: (MessageExtras & OfferExtras) | null = m.extras ?? null;
  if (!extras) return null;
  if (m.role === 'user')
    return extras.movement ? <AttachedMovement movement={extras.movement} /> : null;
  if (m.role !== 'assistant') return null;
  const cited = extras.citedMovements?.length ? extras.citedMovements : null;
  const replies =
    newest && extras.quickReplies?.length ? (
      <QuickReplies replies={extras.quickReplies} disabled={busy} onSend={onReply} />
    ) : null;
  const sheets = extras.offerSources ?? [];
  const offered = !!extras.offer || sheets.length > 0;
  // GL3: a turn that failed or gave no answer stores no plan; one that did never draws a card.
  const { goalPlan, goalCreated } = extras.turnFailed ? {} : extras;
  if (!cited && !replies && !offered && !goalPlan && !goalCreated) return null;
  return (
    <>
      {cited && <CitedMovements movements={cited} />}
      {goalPlan && <GoalPlanCard plan={goalPlan} created={planCreated} />}
      {goalCreated && <GoalCreatedBlock goal={goalCreated} onOpen={onOpenGoal} />}
      {offered ? <OfferBlock offer={extras.offer} sheets={sheets} replies={replies} /> : replies}
    </>
  );
}
