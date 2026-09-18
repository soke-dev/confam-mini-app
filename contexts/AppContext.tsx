import { apiFetch, hasApi } from '@/utils/api';
import { escrowAvailable, fundJob as fundJobOnChain, type TypedData } from '@/utils/escrowApi';
import {
  acceptJob as acceptJobOnServer,
  abandonJob,
  closeQuestion as closeQuestionOnServer,
  myDisputes,
  replyToDisputeOnServer,
  myQuestions,
  takenJobs,
  answeredNearby as fetchAnswered,
  dispatchQuestion,
  fetchNotifications,
  nearbyJobs,
  type ServerJob,
} from '@/utils/questionsApi';
import { hasEvidence, isFinished, isVerifierActive, taskPhase } from '@/utils/taskPhase';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { DEFAULT_DEADLINE, msUntilDeadline } from '@/constants/time';
import { FEE_PERCENT, VERIFIED_ONLY_ABOVE } from '@/constants/money';
import { WALLET_MODE } from '@/utils/privyShared';

export type NearbyTask = {
  id: string;
  title: string;
  description: string;
  location: string;
  area: string; // broad area for filtering e.g. "Ikeja"
  /**
   * The state the area sits in.
   *
   * Carried separately because a place name is not unique across Nigeria —
   * there is an Airport Road in Lagos, in Abuja and in Benin City, and a
   * verifier who reads only the street name can set off for the wrong one.
   */
  state: string;
  distance: string;
  reward: number;
  estimatedTime: string;
  category: 'housing' | 'traffic' | 'fuel' | 'food' | 'shopping' | 'safety' | 'other';
  expiresIn: number;
  status: 'available' | 'accepted' | 'completed';
  viewersCount: number;
  /**
   * First name only. Never a phone number in either direction: nobody meets
   * anybody on this job, so there is no coordination that needs one, and a
   * number is the opening move in most "pay me directly" scams.
   */
  askerName?: string;
  /** The question this job was raised from, if it came from the Ask tab. */
  fromQueryId?: string;
  /**
   * The row in `tasks`, once this person has taken it.
   *
   * Needed to store evidence: the check endpoint files a submission against a
   * task, and without it the photo is examined and then discarded.
   */
  taskId?: string;
  /** What the server says about the job — accepted, submitted, confirmed. */
  serverStatus?: string;
  /**
   * Whether the verifier's claim reached the contract.
   *
   * Null means it did not, and the escrow has nobody recorded to pay — the
   * answer is delivered but the money cannot move until they sign.
   */
  claimTx?: string | null;
  /** Null when the job was never funded on chain. */
  chainJobId?: string | null;
  /** Restricted to verifiers who passed the NIN check. */
  verifiedOnly?: boolean;
  /**
   * When the job expires, as epoch milliseconds.
   *
   * An instant rather than a duration, because a duration has to be counted
   * down by somebody — and a local counter restarts every time the screen is
   * opened, so the deadline appeared to reset. Remaining time is now the
   * difference between this and the clock, which nothing can rewind.
   */
  expiresAt: number;
  questions: {
    id: string;
    type: 'boolean' | 'text' | 'number';
    label: string;
    placeholder?: string;
  }[];
};

/**
 * A place a question is about.
 *
 * Deliberately shaped like a geocoder result rather than like our mock data,
 * so swapping the source (Google Places, Mapbox) for the local list means
 * changing where `Place[]` comes from and nothing else.
 */
export type Place = {
  id: string;
  name: string;
  area: string;
  coords?: { lat: number; lng: number };
  /** True when the user typed a place we do not have on file. */
  freeform?: boolean;
};

/**
 * Whether the answer you paid for may be shown to the next person who asks
 * about the same place. Public is the default because a shared answer is what
 * makes the instant path possible at all — but it is the payer's call, so it
 * is asked rather than assumed.
 */
export type Visibility = 'public' | 'private';

export type Query = {
  id: string;
  /**
   * True from the moment Ask is tapped until the bounty is locked or the
   * attempt fails.
   *
   * Distinct from `dispatchedAt`, which now means what it says: the money is
   * committed. Something has to hold the difference, because during that
   * window the question exists, the wallet is asking for a signature, and the
   * one thing that is not yet true is the thing `dispatchedAt` used to claim.
   */
  funding?: boolean;
  /**
   * The row's id on the server, once it has one.
   *
   * Kept beside the local id rather than replacing it. Screens navigate with
   * the local id the moment a question is sent — waiting on a round trip
   * first would stall the tap — so swapping it afterwards left the tracking
   * screen looking up an id that no longer existed, and it sat on "offered to
   * people nearby" forever.
   */
  serverId?: string;
  /**
   * What the server says happened to the job behind this question.
   *
   * Carried because the asker's own device cannot work it out: an accepted
   * job is not in their `nearbyTasks`, so the app was guessing from the
   * `closed` flag alone — and a question is closed both when it is refunded
   * and when it is confirmed and paid, which is how a completed job came to
   * read "refunded".
   */
  taskStatus?: string | null;
  disputeStatus?: string | null;
  /**
   * Set when the verifier sent the evidence over a check that objected.
   *
   * Carried to the asker because they are the one being asked to accept the
   * answer: the machine had a problem with it, and the person deciding whether
   * to pay is entitled to know that before they decide.
   */
  sentPastCheck?: 'warn' | 'fail' | null;
  /**
   * Who took the job, once somebody has.
   *
   * Carried for the same reason taskStatus is: the asker's device cannot work
   * it out on its own. Without it the tracker opened a finished job reading
   * "Somebody took it" and swapped in the real name once its own fetch landed.
   */
  verifierName?: string | null;
  question: string;
  place: Place | null;
  bounty: number;
  visibility: Visibility;
  /** Minutes the verifier is given, chosen by the asker at dispatch. */
  deadlineMinutes: number;
  /** When the clock started. Null until it has been paid for. */
  dispatchedAt: number | null;
  /** Only identity-verified verifiers may take the job this raised. */
  verifiedOnly: boolean;
  /** Closed by the asker after the window ran out; the bounty went back. */
  closed?: boolean;
  createdAt: number;
};

/**
 * Where a paid question has got to, read from the job it created rather than
 * tracked separately — the two sides cannot disagree if there is only one
 * source of truth.
 */
export type QueryStatus =
  /** Paid, nobody has taken it, still inside the window. */
  | 'waiting'
  /** Somebody is on their way, still inside the window. */
  | 'accepted'
  /** The window ran out with no evidence. The asker may close it. */
  | 'overdue'
  /**
   * Evidence is in and the asker has not ruled on it yet.
   *
   * Split out from 'answered' because the two were one status and are not one
   * state: this one is waiting on *you*. Sharing a status with settled meant
   * evidence arriving moved the question out of Your questions and into
   * History, filing a decision nobody had made.
   */
  | 'delivered'
  /** Confirmed and paid. Nothing further can happen to it. */
  | 'answered'
  /**
   * Queried, and with somebody else now.
   *
   * Missing entirely before, so a task the server had marked `disputed` fell
   * through every branch below and came out as 'waiting' — a question under
   * review read "Waiting for someone" on the very screen the asker went to
   * check on it.
   */
  | 'queried'
  /** The asker closed it and took the money back. */
  | 'refunded';

export type ActiveQuestion = Query & { status: QueryStatus };

/**
 * A contested answer.
 *
 * The money stays held until an admin rules, and neither party can rule on
 * their own dispute — that is why review is a separate surface.
 *
 * The admin screen only offers the decide buttons once the verifier has
 * answered, so in practice both sides are heard. `resolveDispute` itself
 * does not require a reply, deliberately: a verifier who never answers must
 * not be able to strand the asker's money indefinitely.
 */
export type DisputeStatus =
  /** The asker objected; the verifier has not answered yet. */
  | 'awaiting_verifier'
  /** Both sides are in. Waiting on a human. */
  | 'awaiting_admin'
  /** Admin sided with the asker; the bounty went back. */
  | 'resolved_asker'
  /** Admin sided with the verifier; they were paid. */
  | 'resolved_verifier';

export type Dispute = {
  id: string;
  queryId: string;
  taskId: string | null;
  question: string;
  placeName: string;
  bounty: number;
  askerName: string;
  askerReason: string;
  verifierName: string;
  verifierReply: string | null;
  /** What the verifier sent, so an admin can judge without leaving the page. */
  /**
   * `detail` is the representative file; `urls` is all of them.
   *
   * Kept as two fields because a locally-raised dispute has a detail and no
   * server row yet, and dropping that would blank the evidence on the screen
   * of the person who just raised it.
   */
  evidence: { kind: 'photo' | 'video'; detail: string; urls?: string[] };
  status: DisputeStatus;
  adminNote: string | null;
  createdAt: number;
  /** The answer under dispute. Null for a locally-raised one until it syncs. */
  answer: string | null;
  /**
   * Which side of this dispute you are on.
   *
   * There was no such field, and the list is device-local, so every dispute in
   * it was one this device raised — as the asker — while Earn counted them as
   * queries awaiting a verifier's reply. The asker was shown their own query
   * as a job to go and answer.
   */
  role: 'asker' | 'verifier';
};

/** An answer somebody already paid for, reusable if they allowed it. */
export type CachedAnswer = {
  id: string;
  placeName: string;
  area: string;
  answer: string;
  detail: string;
  proof: 'photo' | 'video';
  /** The asker who paid for it accepted it. */
  confirmed: boolean;
  /** How old the answer is. A stale one is worse than none. */
  ageHours: number;
  /**
   * The same age in words, when the server sent one.
   *
   * `ageHours` alone renders "0h ago" for something checked twenty minutes
   * ago, which is the freshest and most persuasive case there is.
   */
  ageLabel?: string;
  verifierName: string;
  verifierInitials: string;
  visibility: Visibility;
};

/**
 * There is no local cache of answers any more.
 *
 * There used to be `findCachedAnswer`, searching a `CACHED_ANSWERS` array that
 * was declared empty and never filled. It matched on place name alone, so even
 * with data it would have offered an answer about a road to somebody asking
 * about a market — and the screen it fed, tipping and all, was therefore never
 * shown to anybody.
 *
 * Judging whether an existing answer addresses a new question is not something
 * a client can do from a list, so it happens on the server: POST /agent/check,
 * which reads the old question, its answer and its age against the new one.
 * `CachedAnswer` above is still the shape that screen renders.
 *
 * Deliberately not left behind as a shim. A function that searches an empty
 * array returns null for ever and reads like a working lookup, which is how it
 * survived this long.
 */

/**
 * The address money is sent to, once Privy has made one.
 *
 * Null until the embedded wallet exists — which is a real state, not an edge
 * case: Privy provisions asynchronously, so there is a window right after
 * signing up where the account is live and the wallet is not.
 *
 * There is deliberately no placeholder to fall back on. This used to hold a
 * fake address behind a warning label, but the QR code rendered from it was
 * perfectly scannable, and a warning is a poor defence against a scanned code.
 * Showing nothing is the only safe thing to show when there is nowhere to send
 * money yet.
 */
export type WalletInfo = { address: string; chain: 'base' } | null;

/** Fallback label for a ledger row that carries no memo. */
function describeEntry(kind: string): string {
  switch (kind) {
    case 'earning':
      return 'Job payment';
    case 'deposit':
      return 'Top up';
    case 'hold':
      return 'Held for a question';
    case 'refund':
      return 'Refund';
    case 'tip':
      return 'Tip sent';
    case 'withdrawal':
      return 'Withdrawal';
    case 'fee':
      return 'Platform fee';
    default:
      return kind;
  }
}

/** Entry kinds that reduce the balance. Mirrors OUTFLOWS on the server. */
const WALLET_OUTFLOWS = new Set(['hold', 'tip', 'fee', 'withdrawal']);

export type WalletEntry = {
  id: string;
  amount: number;
  /** On-chain amount for deposits. Null for naira-denominated entries. */
  amountUsdc?: number | null;
  /** Set for anything that happened on Base, so it can be looked up. */
  txHash?: string | null;
  description: string;
  createdAt: number;
  pending: boolean;
  /** Mirrors the server's wallet_kind enum. Keep the two in step. */
  type: 'earning' | 'deposit' | 'tip' | 'hold' | 'refund' | 'withdrawal' | 'fee';
};

export type User = {
  email: string;
  isSignedIn: boolean;
};

/**
 * What other people see of you. Kept apart from `User` because the account is
 * the email and the password; this is the presentation, and it is editable.
 */
export type Profile = {
  name: string;
  username: string;
  /** Local file URI from the picker. Null falls back to initials. */
  avatarUri: string | null;
};

/** Which events are worth interrupting someone for. */
export type AlertPrefs = {
  jobsNearby: boolean;
  questionTaken: boolean;
  evidenceBack: boolean;
  payments: boolean;
  reviews: boolean;
  productNews: boolean;
};

const DEFAULT_ALERTS: AlertPrefs = {
  jobsNearby: true,
  questionTaken: true,
  evidenceBack: true,
  payments: true,
  reviews: true,
  // Off by default. Nobody installed this to hear from us.
  productNews: false,
};

/**
 * A suggested username for the welcome sheet's field. Never stored on its own.
 *
 * `name` is deliberately left empty. It used to be guessed from the email
 * local part — "chidi.okafor@…" became "Chidi" — which reads as a real name
 * while being nothing of the sort. The only name this app can stand behind is
 * the one returned by the NIN check, so until that happens there is no name.
 */
function profileFromEmail(email: string): Profile {
  const handle = email.split('@')[0] ?? '';
  return {
    name: '',
    username: handle.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20),
    avatarUri: null,
  };
}

export type NotificationKind = 'job' | 'answer' | 'payment' | 'identity' | 'dispute';

export type AppNotification = {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  ago: string;
  today: boolean;
  read: boolean;
  /**
   * Where tapping it should go.
   *
   * Sent by the server, which knows which question or job the alert is about.
   * Without it every notification could only reach a tab, and "your answer is
   * ready" dropped you on Ask to find it yourself.
   */
  href?: string | null;
};

/**
 * Loaded from the server, never seeded.
 *
 * Notifications describe things that actually happened. Seeding them meant a
 * brand-new account opened onto a history it did not have.
 */
const INITIAL_NOTIFICATIONS: AppNotification[] = [];


export type Identity = {
  nin: string;
  status: 'unverified' | 'pending' | 'verified' | 'rejected';
  /** The name on the NIN record. Only ever set by an approved review. */
  name: string | null;
  /** Why a reviewer turned it down, so it can be fixed and resubmitted. */
  reason: string | null;
};

export type AreaFilter = {
  key: string;
  label: string;
} | null;

/** A town or district, with the state it sits in. */
/**
 * Whether a job counts as near the area somebody works in.
 *
 * Matches against the place's name as well as its area, because which of the
 * two holds the locality depends entirely on where the place came from. OSM
 * hands back a coarse area and puts the specific part in the name — the job
 * sitting in Surulere is stored as `area: "Lagos", name: "Surulere"`, so
 * testing `area` alone could never match a verifier who works in Surulere,
 * and the Near me tab was empty while the board plainly had jobs on it.
 *
 * This is also why the area is not pushed to the server, which can filter on
 * `p.area ILIKE` — that filter would miss exactly the same jobs, and further
 * away from anywhere the mismatch is visible.
 *
 * An empty label means nowhere has been chosen yet, and everything is shown
 * rather than nothing.
 */
export function isJobNearArea(
  job: { location?: string; area?: string; state?: string },
  label: string,
): boolean {
  const near = label.trim().toLowerCase();
  if (!near) return true;

  return `${job.location ?? ''} ${job.area ?? ''} ${job.state ?? ''}`.toLowerCase().includes(near);
}

export type Area = { key: string; label: string; state: string };

export const AREAS: Area[] = [
  { key: 'ikeja', label: 'Ikeja', state: 'Lagos' },
  { key: 'vi', label: 'Victoria Island', state: 'Lagos' },
  { key: 'lekki', label: 'Lekki', state: 'Lagos' },
  { key: 'surulere', label: 'Surulere', state: 'Lagos' },
  { key: 'island', label: 'Lagos Island', state: 'Lagos' },
  { key: 'apapa', label: 'Apapa', state: 'Lagos' },
  { key: 'abuja', label: 'Abuja Central', state: 'FCT' },
  { key: 'ph', label: 'Port Harcourt', state: 'Rivers' },
  { key: 'ibadan', label: 'Ibadan', state: 'Oyo' },
  { key: 'benin', label: 'Benin City', state: 'Edo' },
];

/** The state an area sits in, for showing "Ikeja, Lagos" rather than "Ikeja". */
export function stateForArea(area: string): string | null {
  return AREAS.find((a) => a.label.toLowerCase() === area.toLowerCase())?.state ?? null;
}

export type FeedQuestion = {
  id: string;
  text: string;
  area: string;
  state: string;
  /** The spot the question is about, so picking one fills the place too. */
  placeName: string;
};

/** The place a feed question refers to, in the shape the composer expects. */
export function placeForQuestion(question: FeedQuestion): Place {
  return { id: `feed-${question.id}`, name: question.placeName, area: question.area };
}

export type AnsweredQuestion = {
  id: string;
  text: string;
  /** Where it was, at its most specific. Often the only field holding a town. */
  placeName?: string | null;
  area: string;
  state: string;
  proof: 'photo' | 'video';
  /** The asker accepted it and released payment. */
  confirmed: boolean;
  ago: string;
};

/**
 * Questions nearby, from the server. These are other people's real open
 * questions; a fabricated one is a job nobody can take.
 */
const FEED_QUESTIONS: FeedQuestion[] = [];


/**
 * Answered nearby, from the server. Every row here represents somebody who
 * actually went somewhere and was paid for it.
 */
const FEED_ANSWERED: AnsweredQuestion[] = [];


/**
 * Your town first, then the rest of your state.
 *
 * Falling through to the state matters: someone in Lekki should still see
 * that Third Mainland is jammed, and a quiet district would otherwise show
 * an empty feed.
 */
/**
 * Nearby first, then the rest of the state.
 *
 * This compared `item.area === home.label` exactly, and nothing ever matched:
 * a place in Surulere is stored as area "Lagos" with the name "Surulere", so
 * an asker whose home area is Surulere saw an empty feed on a board that had
 * answers on it. The state fallback did not save it either, because
 * `places.state` is null on most rows.
 *
 * Matching the whole of what we know about a place — name, area, state —
 * against the home label is the same approach isJobNearArea takes, for the
 * same reason.
 */
function forArea<T extends { placeName?: string | null; area: string; state: string }>(
  items: T[],
  home: Area | null,
): T[] {
  // Nobody has said where they are, so there is nothing to narrow to. Showing
  // everything answered is the honest answer; showing a filtered feed for a
  // town they never picked is not.
  if (!home) return items;

  const label = home.label.trim().toLowerCase();
  const stateName = home.state.trim().toLowerCase();

  const where = (item: T) =>
    `${item.placeName ?? ''} ${item.area ?? ''} ${item.state ?? ''}`.toLowerCase();

  const inTown = items.filter((item) => label !== '' && where(item).includes(label));
  const inState = items.filter(
    (item) => !inTown.includes(item) && stateName !== '' && where(item).includes(stateName),
  );

  return [...inTown, ...inState];
}

type AppContextType = {
  user: User | null;
  identity: Identity;
  /** Null until Privy finishes creating the embedded wallet. */
  wallet: WalletInfo;
  setWallet: (wallet: WalletInfo) => void;
  /** The area this account calls home; drives the nearby feeds. */
  homeArea: Area | null;
  setHomeArea: (area: Area) => void;
  profile: Profile;
  updateProfile: (patch: Partial<Profile>) => void;
  /**
   * False until the first-run sheet has been answered or skipped.
   *
   * Kept separate from `profile.name` because skipping is a valid outcome:
   * somebody who declines to add a name has still been asked, and asking them
   * again on every launch would be nagging rather than onboarding.
   */
  onboarded: boolean;
  finishOnboarding: () => void;
  /** True once the server has answered — see the state declaration. */
  accountLoaded: boolean;
  setAccountLoaded: (loaded: boolean) => void;
  /** Confirmed jobs, counted on the server. */
  jobsDone: number;
  questionsAsked: number;
  totalDepositedUsdc: number;
  /** False until the ledger has been fetched. */
  walletLoaded: boolean;
  refreshWallet: () => Promise<void>;
  alertPrefs: AlertPrefs;
  setAlertPref: (key: keyof AlertPrefs, value: boolean) => void;
  /** Seeds settings from the server. Does not write back. */
  applyPreferences: (
    prefs: Partial<AlertPrefs> & { answersPublicByDefault?: boolean },
  ) => void;
  /** Pre-selects the sharing switch when a question is dispatched. */
  answersPublicByDefault: boolean;
  setAnswersPublicByDefault: (value: boolean) => void;
  questionsNearby: FeedQuestion[];
  answeredNearby: AnsweredQuestion[];
  /** False until the job feed has been fetched at least once. */
  feedLoaded: boolean;
  refreshJobs: () => Promise<void>;
  refreshDisputes: () => Promise<void>;
  refreshAnswered: () => Promise<void>;
  refreshNotifications: () => Promise<void>;
  /** Paid questions still in flight, newest first. */
  activeQuestions: ActiveQuestion[];
  /** Paid questions that have been answered and settled. */
  answeredQuestions: ActiveQuestion[];
  /** Jobs you accepted and have not yet finished. */
  activeJobs: NearbyTask[];
  /** Jobs you finished and were paid for. */
  completedJobs: NearbyTask[];
  /** Evidence sent, waiting on the asker. */
  deliveredJobs: NearbyTask[];
  /** Queried by the asker, with a reviewer. */
  queriedJobs: NearbyTask[];
  notifications: AppNotification[];
  unreadCount: number;
  markNotificationRead: (id: string) => void;
  markAllNotificationsRead: () => void;
  locationFilter: AreaFilter;
  queries: Query[];
  nearbyTasks: NearbyTask[];
  /** Set when a question was not sent. Null once it succeeds. */
  dispatchError: string | null;
  clearDispatchError: () => void;
  /** Places they have asked about before. Empty on a new account. */
  recentPlaces: Place[];
  /** Questions they have asked before, newest first. */
  recentQuestions: string[];
  /** Jobs this person has taken. */
  myJobs: NearbyTask[];
  refreshMyJobs: () => Promise<void>;
  refreshMyQuestions: () => Promise<void>;
  walletBalance: number;
  pendingBalance: number;
  walletHistory: WalletEntry[];
  /** On-chain USDC. Null until read; never zeroed by a failed read. */
  usdcBalance: number | null;
  /** Block the balance was read at, so the UI can show it is live. */
  balanceBlock: number | null;
  /** Live USD→NGN, or null when unavailable. */
  ngnPerUsd: number | null;
  refreshBalance: () => Promise<number | null>;
  signIn: (email: string) => void;
  signOut: () => void;
  /** Lets AccountSync hand over Privy's logout. */
  registerSignOut: (fn: (() => Promise<void>) | null) => void;
  /** Lets AccountSync hand over the wallet's typed-data signer. */
  registerSigner: (fn: (typedData: TypedData) => Promise<string>) => void;
  submitNin: (nin: string, fullName: string) => Promise<{ ok: boolean; detail?: string }>;
  refreshIdentity: () => Promise<void>;
  setLocationFilter: (filter: AreaFilter) => void;
  depositUsdc: (amount: number) => void;
  /** Sends USDC out to an address the user controls. */
  withdrawUsdc: (amount: number, toAddress: string) => void;
  addQuery: (question: string, place: Place | null) => string;
  /**
   * Committing to pay a human. Separate from asking, because most questions
   * should never reach this point — the price is only decided once the AI has
   * failed and a person actually has to walk somewhere.
   */
  dispatchQuery: (
    id: string,
    bounty: number,
    visibility: Visibility,
    deadlineMinutes: number,
    verifiedOnly: boolean,
  ) => void;
  /**
   * Give up on an overdue question and take the money back. Refused once
   * evidence exists — somebody has already walked there by then.
   */
  closeQuery: (id: string) => Promise<{ ok: boolean; detail?: string }>;
  tipVerifier: (amount: number, verifierName: string) => void;

  disputes: Dispute[];
  /** Raised by the asker. A reason is required — "wrong" is not reviewable. */
  openDispute: (input: {
    queryId: string;
    taskId: string | null;
    question: string;
    placeName: string;
    bounty: number;
    verifierName: string;
    reason: string;
    evidence: { kind: 'photo' | 'video'; detail: string };
  }) => void;
  replyToDispute: (
    id: string,
    reply: string,
  ) => Promise<{ ok: boolean; detail?: string }>;
  /** Admin only. Moves the held money to whichever side was right. */
  resolveDispute: (id: string, winner: 'asker' | 'verifier', note: string) => void;
  disputeForQuery: (queryId: string) => Dispute | null;
  abandonTask: (taskId: string) => Promise<{ ok: boolean; detail?: string }>;
  acceptTask: (
    taskId: string,
    at: { lat: number; lng: number; where?: string | null },
  ) => Promise<{ ok: boolean; detail?: string }>;
  completeTask: (taskId: string, reward: number, description: string) => void;
};

const AppContext = createContext<AppContextType | null>(null);

/**
 * Best guess at what a question is about, for the job's colour code.
 *
 * Kept in step with categorise() in api/src/routes/questions.ts — the server's
 * answer wins for anything that reaches it, and this covers a question before
 * it has been sent. Same order, same fallback, or the same question changes
 * colour the moment it syncs.
 */
function inferCategory(question: string): NearbyTask['category'] {
  const q = question.toLowerCase();
  if (/rent|house|housing|apartment|flat|self[- ]?con|landlord|agent|room|accommodation|lodge/.test(q)) {
    return 'housing';
  }
  if (/traffic|road|bridge|jam|flood|toll|passable/.test(q)) return 'traffic';
  if (/fuel|petrol|diesel|filling|pump|nnpc|mobil/.test(q)) return 'fuel';
  if (/food|restaurant|eat|chicken|jollof|buka|canteen/.test(q)) return 'food';
  if (/market|shop|store|price|buy|supermarket|mall|stock/.test(q)) return 'shopping';
  if (/safe|security|danger|police/.test(q)) return 'safety';
  return 'other';
}

/** "akin@example.com" -> "Akin". First names only, by design. */
function firstNameFrom(email: string | undefined): string {
  const handle = (email ?? 'someone').split('@')[0].split(/[._-]/)[0];
  return handle.charAt(0).toUpperCase() + handle.slice(1);
}

/**
 * A paid question becomes a job on the Earn board. One job, one verifier —
 * it leaves the board the moment somebody accepts it.
 */
function taskFromQuery(query: Query, bounty: number, askerName: string): NearbyTask {
  return {
    id: `t-${query.id}`,
    title: query.question,
    description: `Go to ${query.place?.name ?? 'the place'} and answer the asker's question in person. Photo or video proof required.`,
    location: query.place?.name ?? 'Unknown place',
    area: query.place?.area ?? '',
    distance: 'Nearby',
    reward: bounty,
    estimatedTime: '~5 min',
    category: inferCategory(query.question),
    // The asker's own deadline, not a fixed fifteen minutes.
    state: query.place ? (stateForArea(query.place.area) ?? '') : '',
    expiresIn: query.deadlineMinutes,
    expiresAt: (query.dispatchedAt ?? Date.now()) + query.deadlineMinutes * 60_000,
    status: 'available',
    viewersCount: 1,
    askerName,
    fromQueryId: query.id,
    verifiedOnly: query.verifiedOnly,
    questions: [
      {
        id: 'a1',
        type: 'text',
        label: query.question,
        placeholder: 'Answer in a sentence',
      },
    ],
  };
}

/**
 * Jobs on the Earn tab, from the server. A seeded job is a promise of work
 * and money that does not exist behind it.
 */
const INITIAL_TASKS: NearbyTask[] = [];


/**
 * A new account starts empty, because a new account *is* empty.
 *
 * This used to hold six invented earnings totalling ₦1,700 across five jobs.
 * They rendered in the same place as real figures with no way to tell them
 * apart, so the profile reported work that had never happened and money that
 * did not exist. Real entries arrive from /auth/wallet.
 */
const INITIAL_WALLET: WalletEntry[] = [];

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [identity, setIdentity] = useState<Identity>({
    nin: '',
    status: 'unverified',
    name: null,
    reason: null,
  });
  const [wallet, setWallet] = useState<WalletInfo>(null);
  /**
   * No area until somebody chooses one.
   *
   * This was AREAS[0], which is Ikeja, so every account that had not picked
   * anything was silently placed in Lagos: the feed filtered to it, the job
   * count counted it, and the Ask tab printed its name as though the person
   * had said so. Somebody signing up in Benin City saw a different city's
   * answers and no indication why.
   *
   * Null is the truthful state and every reader now handles it: the feed
   * stops filtering, and the labels say so rather than naming a place.
   */
  const [homeArea, setHomeArea] = useState<Area | null>(null);
  const [profile, setProfile] = useState<Profile>({ name: '', username: '', avatarUri: null });
  const [onboarded, setOnboarded] = useState(false);
  /**
   * False until the server has been asked what this account looks like.
   *
   * Without it, every screen has to treat "not loaded yet" and "loaded, and
   * the answer is no" as the same thing. The welcome sheet did exactly that
   * and reopened on every refresh, because local state starts at
   * `onboarded: false` and the answer only arrives a round trip later.
   */
  const [accountLoaded, setAccountLoaded] = useState(false);
  const [alertPrefs, setAlertPrefs] = useState<AlertPrefs>(DEFAULT_ALERTS);
  const [answersPublicByDefault, setAnswersPublicByDefault] = useState(true);
  const [notifications, setNotifications] = useState<AppNotification[]>(INITIAL_NOTIFICATIONS);
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [locationFilter, setLocationFilter] = useState<AreaFilter>(null);
  const [queries, setQueries] = useState<Query[]>([]);

  // Mirrors `queries` so dispatchQuery can read the question it is being
  // paid for without taking the whole list as a dependency.
  const queriesRef = useRef<Query[]>([]);
  useEffect(() => {
    queriesRef.current = queries;
  }, [queries]);

  // Mirrors the board so closeQuery can check for evidence without taking
  // the whole task list as a dependency.
  const tasksRef = useRef<NearbyTask[]>([]);

  // Mirrors the disputes so resolveDispute can read the one it is settling.
  const disputesRef = useRef<Dispute[]>([]);
  const [nearbyTasks, setNearbyTasks] = useState<NearbyTask[]>(INITIAL_TASKS);
  const [answeredFeed, setAnsweredFeed] = useState<AnsweredQuestion[]>([]);
  /** Why the last dispatch did not go through, if it did not. */
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  /**
   * Jobs this person has taken.
   *
   * Held apart from `nearbyTasks` because the two lists mean opposite things:
   * one is what is still available, the other is what is no longer available
   * because you took it. Accepting moves a job between them.
   */
  const [myJobs, setMyJobs] = useState<NearbyTask[]>([]);
  const [feedLoaded, setFeedLoaded] = useState(false);
  useEffect(() => {
    tasksRef.current = nearbyTasks;
  }, [nearbyTasks]);

  useEffect(() => {
    disputesRef.current = disputes;
  }, [disputes]);
  const [walletHistory, setWalletHistory] = useState<WalletEntry[]>(INITIAL_WALLET);
  /**
   * The on-chain USDC balance, or null when it has not been read.
   *
   * Null is a real state and is rendered differently from zero: "we could not
   * ask the chain" and "you have nothing" are opposite messages, and showing
   * $0.00 for the first is a claim about someone's money we are in no position
   * to make.
   */
  const [usdcBalance, setUsdcBalance] = useState<number | null>(null);
  const [balanceBlock, setBalanceBlock] = useState<number | null>(null);
  /**
   * Live USD→NGN. Null when the rate could not be fetched, which hides the
   * naira figure rather than falling back to a hard-coded number that would
   * look identical to a real one.
   */
  const [ngnPerUsd, setNgnPerUsd] = useState<number | null>(null);
  /** Counted from confirmed jobs on the server, not from ledger rows. */
  const [jobsDone, setJobsDone] = useState(0);
  /** Sum of deposits in USDC, which is the currency they arrived in. */
  const [totalDepositedUsdc, setTotalDepositedUsdc] = useState(0);
  const [questionsAsked, setQuestionsAsked] = useState(0);
  const [walletLoaded, setWalletLoaded] = useState(false);

  // Status comes from the job each question created, so the asker's view and
  // the verifier's view can never drift apart.
  const paidQuestions: ActiveQuestion[] = queries
    .filter((q) => q.bounty > 0)
    .map((q) => {
      const job = nearbyTasks.find((t) => t.fromQueryId === q.id);
      const overdue = msUntilDeadline(q.dispatchedAt, q.deadlineMinutes) <= 0;

      // Order matters. Evidence outranks the clock: once it is in, a passed
      // deadline no longer entitles the asker to the money back.
      /**
       * Order matters. Evidence outranks the clock: once it is in, a passed
       * deadline no longer entitles the asker to the money back.
       *
       * The server's task status is preferred over anything local, because it
       * is the only side that knows what the verifier did.
       */
      const phase = taskPhase(q.taskStatus);

      /**
       * A dispute row exists a moment before the task flips to 'disputed', so
       * both are consulted. A resolved one is not a live query — whatever it
       * settled on is already in the phase.
       */
      const queried =
        phase === 'queried' ||
        q.disputeStatus === 'awaiting_verifier' ||
        q.disputeStatus === 'awaiting_admin';

      /**
       * Order is the logic. Settled outranks a query, because a confirmed and
       * paid job is finished whatever was said on the way. A query outranks
       * delivery, because disputed evidence is evidence that arrived — reading
       * delivery first is what let 'answered' hide an open query.
       */
      const status: QueryStatus =
        isFinished(phase)
          ? 'answered'
          : q.closed
            ? 'refunded'
            : queried
              ? 'queried'
              : phase === 'delivered'
                ? 'delivered'
                : phase === 'working' || job?.status === 'accepted'
                  ? 'accepted'
                  : phase === 'expired' || overdue
                    ? 'overdue'
                    : 'waiting';

      return { ...q, status };
    })
    /**
     * Newest first, by timestamp rather than by position.
     *
     * This was .reverse(), which only ever worked by accident: it assumed the
     * list arrived oldest-first because addQuery appends a new local question
     * to the end. /questions/mine already returns ORDER BY created_at DESC,
     * so reversing turned the server's newest-first into oldest-first and
     * buried the most recent question at the bottom of History.
     *
     * Sorting on createdAt is right for both sources at once — a local
     * question not yet sent to the server still carries the moment it was
     * typed, so it sorts to the top without depending on where it sits.
     */
    .sort((a, b) => b.createdAt - a.createdAt);

  // Money out: tips, and bounties held against an open question. Money in:
  // earnings, top-ups, and refunds when a question is closed unanswered.
  const walletBalance = walletHistory
    .filter((e) => !e.pending)
    .reduce(
      // Same rule as the server: everything that leaves the wallet subtracts.
      // See OUTFLOWS in api/src/routes/auth.ts — the two must agree.
      (sum, e) => (WALLET_OUTFLOWS.has(e.type) ? sum - e.amount : sum + e.amount),
      0,
    );
  const pendingBalance = walletHistory.filter((e) => e.pending).reduce((s, e) => s + e.amount, 0);

  /**
   * Opens the session. Deliberately does not invent a username.
   *
   * This used to seed one from the email local part, which then rendered
   * everywhere as though the person had chosen it — so someone whose real
   * username was "soke" saw "@coolexcollins" until /auth/me answered, and kept
   * seeing it for good if that request failed. A guess that is indistinguishable
   * from the real value is worse than a blank.
   *
   * The welcome sheet still offers the same suggestion, but as a default in an
   * editable field rather than as a stored fact.
   */
  const signIn = useCallback((email: string) => {
    setUser({ email, isSignedIn: true });
  }, []);

  const finishOnboarding = useCallback(() => setOnboarded(true), []);

  /**
   * Ends the Privy session too.
   *
   * Set by AccountSync, which is the component that can reach the Privy hook.
   * Without it `signOut` cleared local state only — and since the navigator
   * treats Privy as the authority on who is signed in, a live Privy session
   * kept you in the app and the button appeared to do nothing.
   */
  /**
   * The wallet's typed-data signer, handed over by AccountSync.
   *
   * Signing is a hook and this is not a component, so the function is
   * registered rather than called directly — the same arrangement as the token
   * getter and the sign-out handler.
   */
  const signRef = useRef<(typedData: TypedData) => Promise<string>>(async () => {
    throw new Error('No wallet is available to sign with.');
  });
  const registerSigner = useCallback((fn: (typedData: TypedData) => Promise<string>) => {
    signRef.current = fn;
  }, []);

  const privySignOutRef = useRef<(() => Promise<void>) | null>(null);
  const registerSignOut = useCallback((fn: (() => Promise<void>) | null) => {
    privySignOutRef.current = fn;
  }, []);

  /**
   * Signs out, and forgets everything about the person.
   *
   * All of it, not just `user`. Profile, wallet, ledger, questions, jobs and
   * notifications are one person's data on a device somebody else may pick up
   * next — leaving them in memory means the next sign-in briefly renders the
   * previous account's balance and questions before the server replaces them.
   */
  const signOut = useCallback(() => {
    setUser(null);
    setProfile({ name: '', username: '', avatarUri: null });
    setIdentity({ nin: '', status: 'unverified', name: null, reason: null });
    setWallet(null);
    setUsdcBalance(null);
    setBalanceBlock(null);
    setWalletHistory([]);
    setJobsDone(0);
    setQuestionsAsked(0);
    setTotalDepositedUsdc(0);
    setWalletLoaded(false);
    setAccountLoaded(false);
    setQueries([]);
    setDisputes([]);
    setNearbyTasks([]);
    setAnsweredFeed([]);
    setNotifications([]);
    setOnboarded(false);

    // Last, because it is the slow part and everything above should already
    // be gone by the time the navigator re-renders.
    void privySignOutRef.current?.();
  }, []);

  /**
   * Flips a setting and saves it, rolling back if the save fails.
   *
   * Optimistic on purpose: a toggle that waits on a round trip before moving
   * feels broken, and these are low-stakes. But it must not *lie* — if the
   * write fails the switch goes back to where it was, so what is on screen is
   * always what is stored rather than what was merely attempted.
   */
  /**
   * Pulls the ledger and the figures derived from it.
   *
   * Kobo on the wire, naira in the app: the server stores integers so nothing
   * drifts, and the conversion happens here, once, rather than at each screen
   * that shows an amount.
   */
  /**
   * Lets refreshBalance call refreshWallet without either having to be
   * declared first — they are mutually reachable, and a direct reference in
   * the dependency array would need one of them to exist before the other.
   */
  const refreshWalletRef = useRef<(() => Promise<void>) | null>(null);
  const refreshMyQuestionsRef = useRef<(() => Promise<void>) | null>(null);

  const refreshWallet = useCallback(async () => {
    if (!hasApi) {
      setWalletLoaded(true);
      return;
    }

    const result = await apiFetch<{
      balanceKobo: number;
      earnedKobo: number;
      depositedUsdc: number;
      jobsDone: number;
      questionsAsked: number;
      entries: {
        id: string;
        kind: WalletEntry['type'];
        amountKobo: number;
        amountUsdc: number | null;
        txHash: string | null;
        pending: boolean;
        memo: string | null;
        createdAt: string;
        question: string | null;
      }[];
    }>('/auth/wallet');

    if (!result.ok) {
      setWalletLoaded(true);
      return;
    }

    setWalletHistory(
      result.data.entries.map((e) => ({
        id: e.id,
        amount: e.amountKobo / 100,
        // Present only for on-chain rows. Deposits are denominated in USDC,
        // so the naira column is a conversion rather than the amount itself.
        amountUsdc: e.amountUsdc,
        txHash: e.txHash,
        description: e.memo ?? e.question ?? describeEntry(e.kind),
        createdAt: new Date(e.createdAt).getTime(),
        pending: e.pending,
        type: e.kind,
      })),
    );
    setTotalDepositedUsdc(result.data.depositedUsdc);
    setJobsDone(result.data.jobsDone);
    setQuestionsAsked(result.data.questionsAsked);
    setWalletLoaded(true);
  }, []);

  refreshWalletRef.current = refreshWallet;

  /**
   * Reads the balance straight from Base.
   *
   * Polled rather than pushed: an HTTP RPC has no way to tell us a transfer
   * happened, so the choice is between asking periodically and holding a
   * WebSocket subscription open to a node. Polling while the wallet is on
   * screen is a fraction of the complexity and, at Base's ~2s blocks, close
   * enough to live that the difference is not visible.
   */
  /**
   * Returns what it read, as well as storing it.
   *
   * Callers that need the balance to decide something cannot use the state it
   * sets: that lands on the next render, and the decision is being made now.
   * Sending a question was doing exactly that and reading a stale figure.
   */
  const refreshBalance = useCallback(async (): Promise<number | null> => {
    if (!hasApi) return null;

    /**
     * The balance first, the deposit scan after.
     *
     * Reading the balance is one eth_call and returns in well under a second.
     * Scanning for deposits walks up to eight ranges of Base logs in sequence
     * and can take ten — and it used to run first, so every screen waiting on
     * a balance waited on the scan as well.
     *
     * Nothing about the balance depends on the scan: the chain already knows
     * what the wallet holds. The scan only writes the ledger rows that explain
     * where it came from, which can land a moment later.
     */

    /**
     * Which chain to count on.
     *
     * The mini app runs inside a wallet host that offers Polygon and not Base,
     * so the money in front of that person is USDT on Polygon. Showing them
     * the Base balance would be answering a different question to the one they
     * are asking — usually with a zero, because they have never held anything
     * there.
     *
     * The client says which, because the client is the only one that knows:
     * the same kind of session is used by the phone app, whose embedded wallet
     * is on Base.
     */
    const result = await apiFetch<{
      /** The honest pair. `usdc` is the same number, kept for older builds. */
      amount?: number | null;
      token?: 'USDC' | 'USDT';
      usdc: number | null;
      blockNumber: number | null;
      ngnPerUsd: number | null;
      status: string;
    }>(WALLET_MODE ? '/auth/balance?chain=polygon' : '/auth/balance');

    const amount = result.ok ? (result.data.amount ?? result.data.usdc) : null;

    if (!result.ok || amount === null || amount === undefined) {
      // Left as it was rather than zeroed — a failed read is not a balance.
      setBalanceBlock(null);
      // Null means "could not tell", which callers must not read as "broke".
      return null;
    }

    setUsdcBalance(amount);
    setBalanceBlock(result.data.blockNumber);
    if (result.data.ngnPerUsd) setNgnPerUsd(result.data.ngnPerUsd);

    /*
     * Now the slow part, with nothing waiting on it. The ledger is only
     * re-read when something actually landed, rather than every poll.
     *
     * Skipped entirely in the mini app. The scan exists to notice money
     * arriving in an embedded wallet — an address this app created, which
     * somebody funds by sending to it. A person signing with their own wallet
     * never does that: they add money to it wherever they normally would, and
     * the escrow pays them directly. Scanning Base for them would be looking
     * for deposits that are not coming, on a chain they are not using, every
     * twelve seconds.
     */
    if (!WALLET_MODE) {
      void (async () => {
        const sync = await apiFetch<{ inserted: number }>('/auth/deposits/sync', {
          method: 'POST',
        });
        if (sync.ok && sync.data.inserted > 0) void refreshWalletRef.current?.();
      })();
    }

    // The scan above is deliberately not awaited; the balance is already known.
    return amount;
  }, []);

  /**
   * Open jobs other people have posted.
   *
   * Shaped into NearbyTask here rather than on the server, because the card
   * is a client concern — the server sends the facts and this decides how a
   * countdown or a distance should read.
   */
  /**
   * Replaces the local dispute list with the server's, both sides included.
   *
   * The list was only ever written by whoever raised a query, so it existed on
   * one phone and the other party never saw it. The server knows both parties
   * and says which one you are, so that is where the list has to come from.
   */
  const refreshDisputes = useCallback(async () => {
    if (!hasApi) return;
    const result = await myDisputes();
    if (!result.ok) return;

    setDisputes(
      result.data.disputes.map((d) => ({
        id: d.id,
        queryId: d.questionId,
        taskId: null,
        question: d.question,
        placeName: d.placeName ?? 'Unknown place',
        bounty: d.bountyKobo / 100,
        askerName: d.askerName ?? 'Someone',
        askerReason: d.askerReason,
        verifierName: d.verifierName ?? 'Someone',
        verifierReply: d.verifierReply,
        evidence: {
          kind: d.evidenceKind ?? 'photo',
          detail: d.evidenceUrl ?? '',
          urls: d.evidenceUrls,
        },
        status: d.status as DisputeStatus,
        adminNote: d.adminNote,
        createdAt: new Date(d.createdAt).getTime(),
        answer: d.answer,
        role: d.role,
      })),
    );
  }, []);

  const refreshJobs = useCallback(async () => {
    if (!hasApi) {
      setFeedLoaded(true);
      return;
    }

    const result = await nearbyJobs();
    if (!result.ok) {
      setFeedLoaded(true);
      return;
    }

    setNearbyTasks(
      result.data.jobs.map((job: ServerJob) => ({
        id: job.id,
        title: job.text,
        // What to do, not where — the place is already on its own line, and
        // repeating it read as a rendering bug.
        description: 'Go there, see for yourself, and send photo or video proof of what you find.',
        location: job.placeName ?? 'Nearby',
        area: job.area ?? '',
        state: job.state ?? '',
        // Honest about not knowing: we have no fix on the verifier's position
        // when the list is drawn, and a made-up "1.2km" is worse than a blank.
        distance: '',
        reward: job.bountyKobo / 100,
        estimatedTime: `${job.deadlineMinutes}m`,
        category: job.category,
        expiresIn: job.minutesLeft,
        expiresAt: Date.now() + job.minutesLeft * 60_000,
        status: 'available' as const,
        viewersCount: 0,
        askerName: job.askerName ?? undefined,
        fromQueryId: job.id,
        verifiedOnly: job.verifiedOnly,
        /**
         * One free-text field, always.
         *
         * The photo shows the place; this is where the verifier says what it
         * means — "no queue", "closed until Monday". Without it the asker gets
         * an image and has to work out the answer themselves, which is the
         * job they paid somebody else to do.
         */
        questions: [
          {
            id: 'what',
            type: 'text' as const,
            label: 'What did you find?',
            placeholder: 'Say it plainly — the asker reads this first.',
          },
        ],
      })),
    );
    setFeedLoaded(true);
  }, []);

  /** Shapes a server job into the card the app renders. */
  const toTask = useCallback(
    (
      job: ServerJob & {
        taskId?: string;
        taskStatus?: string;
        claimTx?: string | null;
        chainJobId?: string | null;
      },
      status: NearbyTask['status'] = 'available',
    ): NearbyTask => ({
      id: job.id,
      title: job.text,
      description:
        'Go there, see for yourself, and send photo or video proof of what you find.',
      location: job.placeName ?? 'Nearby',
      area: job.area ?? '',
      state: job.state ?? '',
      distance: '',
      reward: job.bountyKobo / 100,
      estimatedTime: `${job.deadlineMinutes}m`,
      category: job.category,
      expiresIn: job.minutesLeft,
      expiresAt: Date.now() + job.minutesLeft * 60_000,
      status,
      viewersCount: 0,
      askerName: job.askerName ?? undefined,
      fromQueryId: job.id,
      taskId: job.taskId,
      serverStatus: job.taskStatus,
      claimTx: job.claimTx ?? null,
      chainJobId: job.chainJobId ?? null,
      verifiedOnly: job.verifiedOnly,
      questions: [
        {
          id: 'what',
          type: 'text' as const,
          label: 'What did you find?',
          placeholder: 'Say it plainly — the asker reads this first.',
        },
      ],
    }),
    [],
  );

  /**
   * The asker's own questions, from the server.
   *
   * `queries` was local state only, so a refresh emptied it — a question could
   * be funded, dispatched and sitting on the board while the person who paid
   * for it had no way to reach it. The server has always had them; nothing
   * ever asked.
   */
  const refreshMyQuestions = useCallback(async () => {
    if (!hasApi) return;
    const result = await myQuestions();
    if (!result.ok) return;

    setQueries(
      result.data.questions.map((q) => ({
        // The server id doubles as the local one for anything it sent us:
        // there is no earlier local identity to preserve.
        id: q.id,
        serverId: q.id,
        question: q.text,
        place: q.placeName
          ? { id: q.id, name: q.placeName, area: q.area ?? '' }
          : null,
        bounty: q.bountyKobo / 100,
        visibility: q.visibility,
        deadlineMinutes: q.deadlineMinutes,
        dispatchedAt: q.dispatchedAt ? new Date(q.dispatchedAt).getTime() : null,
        verifiedOnly: q.verifiedOnly,
        closed: Boolean(q.closedAt),
        taskStatus: q.taskStatus,
        verifierName: q.verifierName,
        disputeStatus: q.disputeStatus,
        sentPastCheck: q.sentPastCheck,
        /**
         * The server's own created_at, not the dispatch time.
         *
         * Falling back to Date.now() for an undispatched question made its
         * age change on every refresh, so it drifted to the top of History
         * on its own. A question that has been asked has a creation time
         * whether or not it was ever paid for and sent out.
         */
        createdAt: new Date(q.createdAt).getTime(),
      })),
    );
  }, []);

  refreshMyQuestionsRef.current = refreshMyQuestions;

  const refreshMyJobs = useCallback(async () => {
    if (!hasApi) return;
    const result = await takenJobs();
    if (!result.ok) return;
    setMyJobs(
      result.data.jobs.map((job) =>
        /**
         * Submitted is still in flight, not finished.
         *
         * Mapping it to 'completed' dropped a job out of "You are doing this"
         * the moment evidence was sent — so a verifier waiting on the asker
         * had no way back to it and no sign it existed.
         */
        toTask(job, job.taskStatus === 'confirmed' ? 'completed' : 'accepted'),
      ),
    );
  }, [toTask]);

  const refreshAnswered = useCallback(async () => {
    if (!hasApi) return;
    const result = await fetchAnswered();
    if (result.ok) setAnsweredFeed(result.data.answered);
  }, []);

  const refreshNotifications = useCallback(async () => {
    if (!hasApi) return;
    const result = await fetchNotifications();
    if (!result.ok) return;

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    setNotifications(
      result.data.notifications.map((n) => {
        const at = new Date(n.at);
        const minutes = Math.max(1, Math.round((Date.now() - at.getTime()) / 60_000));
        const ago =
          minutes < 60
            ? `${minutes}m`
            : minutes < 1440
              ? `${Math.round(minutes / 60)}h`
              : `${Math.round(minutes / 1440)}d`;
        return {
          id: n.id,
          kind: (n.kind as NotificationKind) ?? 'job',
          title: n.title,
          body: n.body ?? '',
          ago,
          today: at >= startOfToday,
          href: n.href,
          // Read state is not tracked server-side yet, so everything arrives
          // unread rather than pretending to remember.
          read: false,
        };
      }),
    );
  }, []);

  /**
   * Places this person has actually asked about, newest first.
   *
   * Replaces a hardcoded list of Lagos landmarks that every account saw as
   * "Saved places" — including somebody in Kano on their first day, who had
   * saved nothing and lived nowhere near any of them.
   */
  const recentPlaces = useMemo(() => {
    const seen = new Set<string>();
    const places: Place[] = [];
    for (const q of [...queries].reverse()) {
      if (!q.place) continue;
      const key = q.place.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      places.push(q.place);
      if (places.length >= 8) break;
    }
    return places;
  }, [queries]);

  /**
   * Questions this person has asked before, for the compose suggestions.
   *
   * Their own come first: somebody checking the same filling station every
   * morning should not have to retype it. Other people's open questions fill
   * in behind, and are all a new account has.
   */
  const recentQuestions = useMemo(() => {
    const seen = new Set<string>();
    const asked: string[] = [];
    for (const q of [...queries].reverse()) {
      const key = q.question.trim().toLowerCase();
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      asked.push(q.question);
      if (asked.length >= 6) break;
    }
    return asked;
  }, [queries]);

  const clearDispatchError = useCallback(() => setDispatchError(null), []);

  const setAlertPref = useCallback((key: keyof AlertPrefs, value: boolean) => {
    setAlertPrefs((prev) => ({ ...prev, [key]: value }));
    if (!hasApi) return;

    void (async () => {
      const result = await apiFetch('/auth/preferences', {
        method: 'PATCH',
        body: JSON.stringify({ [key]: value }),
      });
      if (!result.ok) {
        setAlertPrefs((prev) => ({ ...prev, [key]: !value }));
        console.warn(`[prefs] ${key} did not save — ${result.detail}`);
      }
    })();
  }, []);

  /** Same contract as the alert toggles: optimistic, but never a false state. */
  const setAnswersPublic = useCallback((value: boolean) => {
    setAnswersPublicByDefault(value);
    if (!hasApi) return;

    void (async () => {
      const result = await apiFetch('/auth/preferences', {
        method: 'PATCH',
        body: JSON.stringify({ answersPublicByDefault: value }),
      });
      if (!result.ok) {
        setAnswersPublicByDefault(!value);
        console.warn(`[prefs] answersPublicByDefault did not save — ${result.detail}`);
      }
    })();
  }, []);

  /** Applies what the server has, without triggering a write back to it. */
  const applyPreferences = useCallback(
    (prefs: Partial<AlertPrefs> & { answersPublicByDefault?: boolean }) => {
      const { answersPublicByDefault: shared, ...alerts } = prefs;
      if (Object.keys(alerts).length > 0) {
        setAlertPrefs((prev) => ({ ...prev, ...alerts }));
      }
      if (typeof shared === 'boolean') setAnswersPublicByDefault(shared);
    },
    [],
  );

  const updateProfile = useCallback((patch: Partial<Profile>) => {
    setProfile((prev) => ({ ...prev, ...patch }));
  }, []);

  const markNotificationRead = useCallback((id: string) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
  }, []);

  const markAllNotificationsRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  }, []);

  /**
   * Sends a NIN for review. Nothing here decides the outcome.
   *
   * This used to set `pending`, wait three seconds on a timer, and then set
   * `verified` — every person who typed eleven digits became verified, which
   * made the shield next to a name mean nothing at all. The decision now
   * belongs to a reviewer, and this only reports what the server accepted.
   */
  const submitNin = useCallback(
    async (nin: string, fullName: string): Promise<{ ok: boolean; detail?: string }> => {
      if (!hasApi) {
        return { ok: false, detail: 'No server is configured in this build.' };
      }

      const result = await apiFetch<{ status: string }>('/identity/submit', {
        method: 'POST',
        body: JSON.stringify({ nin, fullName }),
      });

      if (!result.ok) {
        // An already-queued check is not an error worth alarming anyone with.
        if (result.code === 'already_pending') {
          setIdentity((prev) => ({ ...prev, nin, status: 'pending', reason: null }));
          return { ok: true };
        }
        return { ok: false, detail: result.detail };
      }

      setIdentity((prev) => ({ ...prev, nin, status: 'pending', reason: null }));
      return { ok: true };
    },
    [],
  );

  /** Reads the reviewer's decision. Called on mount and on demand. */
  const refreshIdentity = useCallback(async () => {
    if (!hasApi) return;
    const result = await apiFetch<{
      status: Identity['status'];
      name: string | null;
      reason: string | null;
    }>('/identity/status');
    if (!result.ok) return;
    setIdentity((prev) => ({
      ...prev,
      status: result.data.status,
      name: result.data.name,
      reason: result.data.reason,
    }));
  }, []);

  const withdrawUsdc = useCallback((amount: number, toAddress: string) => {
    // Deliberately does not touch usdcBalance. That number is read from Base,
    // and nothing here broadcasts a transaction — decrementing it would show
    // money leaving a wallet it is still sitting in.
    setWalletHistory((prev) => [
      {
        id: `wd-${Date.now()}`,
        amount,
        // Only the ends of the address: enough to recognise the destination,
        // short enough to read in a list.
        description: `Withdrawn to ${toAddress.slice(0, 6)}…${toAddress.slice(-4)}`,
        createdAt: Date.now(),
        pending: false,
        type: 'withdrawal',
      },
      ...prev,
    ]);
  }, []);

  const depositUsdc = useCallback((amount: number) => {
    // Only meaningful once a real balance has been read; adding to an unknown
    // would invent one.
    setUsdcBalance((b) => (b === null ? b : b + amount));
    const id = Date.now().toString();
    setWalletHistory((prev) => [
      { id, amount, description: `USDC deposit · Base network`, createdAt: Date.now(), pending: false, type: 'deposit' },
      ...prev,
    ]);
  }, []);

  const addQuery = useCallback((question: string, place: Place | null): string => {
    const id = Date.now().toString() + Math.random().toString(36).slice(2, 8);
    setQueries((prev) => [
      ...prev,
      // No bounty yet: asking is free, and most questions never need one.
      {
        id,
        question,
        place,
        bounty: 0,
        visibility: 'public',
        deadlineMinutes: DEFAULT_DEADLINE,
        dispatchedAt: null,
        verifiedOnly: false,
        createdAt: Date.now(),
      },
    ]);
    return id;
  }, []);

  const dispatchQuery = useCallback(
    (
      id: string,
      bounty: number,
      visibility: Visibility,
      deadlineMinutes: number,
      verifiedOnly: boolean,
    ) => {
      const query = queriesRef.current.find((q) => q.id === id);
      // `funding` as well as `dispatchedAt`: the first no longer becomes true
      // straight away, so on its own it would let a second tap through while
      // the wallet is still asking about the first.
      if (!query || query.dispatchedAt || query.funding) return;

      const dispatchedAt = Date.now();
      // Big errands are restricted whether or not the asker ticked the box.
      const restricted = verifiedOnly || bounty >= VERIFIED_ONLY_ABOVE;

      /**
       * Create it, then lock the money. In that order, and both must land.
       *
       * The question is not a job anybody can see until fund() confirms — the
       * server leaves `dispatched_at` null until then. That is deliberate:
       * advertising a bounty before it is committed lets somebody post one,
       * decline the signature, and send a verifier walking for money that was
       * never taken from anyone.
       */
      void (async () => {
        if (!hasApi) return;

        const created = await dispatchQuestion({
          text: query.question,
          placeName: query.place?.name ?? 'Somewhere nearby',
          area: query.place?.area ?? null,
          state: query.place ? stateForArea(query.place.area) : null,
          lat: query.place?.coords?.lat ?? null,
          lng: query.place?.coords?.lng ?? null,
          bounty,
          deadlineMinutes,
          visibility,
          verifiedOnly: restricted,
        });

        if (!created.ok) {
          setDispatchError(created.detail);
          // Nothing was sent, so nothing has to be undone — only the flag that
          // said an attempt was in flight.
          setQueries((prev) =>
            prev.map((q) => (q.id === id ? { ...q, dispatchedAt: null, funding: false } : q)),
          );
          return;
        }

        setQueries((prev) =>
          prev.map((q) => (q.id === id ? { ...q, serverId: created.data.id } : q)),
        );

        if (!created.data.needsFunding) {
          // Nothing to sign, so nothing to wait for.
          setQueries((prev) =>
            prev.map((q) => (q.id === id ? { ...q, dispatchedAt, funding: false } : q)),
          );
          void refreshJobs();
          return;
        }

        const funded = await fundJobOnChain(created.data.id, signRef.current);

        if (!funded.ok) {
          setDispatchError(
            funded.code === 'declined'
              ? 'You cancelled the signature, so nothing was sent. Your money has not moved.'
              : `The bounty could not be locked — ${funded.detail}`,
          );
          setQueries((prev) =>
            prev.map((q) => (q.id === id ? { ...q, dispatchedAt: null, funding: false } : q)),
          );
          return;
        }

        // Locked. Only now is it a job, and only now does it say so.
        setQueries((prev) =>
          prev.map((q) => (q.id === id ? { ...q, dispatchedAt, funding: false } : q)),
        );
        void refreshJobs();
        void refreshMyQuestionsRef.current?.();
        void refreshWalletRef.current?.();
      })();

      /**
       * The settings apply at once; the claim that it was sent does not.
       *
       * `dispatchedAt` used to be written here, before the signature was even
       * asked for. On a phone, where the embedded wallet signs without a
       * prompt, the gap was invisible. Inside a wallet host it is a modal that
       * waits on a person: the question appeared as asked, and only then did
       * the wallet surface — so the bounty looked created before anyone had
       * agreed to pay it, and cancelling meant watching it disappear again.
       *
       * The comment below this already made the argument for the ledger and
       * the board. This is the last optimistic claim of the three.
       */
      setQueries((prev) =>
        prev.map((q) =>
          q.id === id
            ? {
                ...q,
                bounty,
                visibility,
                deadlineMinutes,
                verifiedOnly: restricted,
                dispatchedAt: null,
                funding: true,
              }
            : q,
        ),
      );

      /**
       * No optimistic hold, and no optimistic board entry.
       *
       * Both used to be written here, before the money moved. The ledger
       * showed a hold against a bounty that might never be locked, and the
       * Earn board showed a job that might never be funded — which is exactly
       * the state that lets a verifier walk somewhere for nothing.
       *
       * The server writes both when fund() confirms, and refreshJobs and
       * refreshWallet bring them back. A moment's delay is the honest cost of
       * only showing what is true.
       */
    },
    [user?.email],
  );

  /**
   * Closes the question and takes the bounty back — on the server, which is
   * where the money is.
   *
   * This wrote a local `closed` flag and a local refund row and stopped there.
   * `closeQuestion` existed and was never called, so nothing was refunded,
   * nothing was closed, and the next refreshMyQuestions brought the question
   * back open with the money still held. The refund button appeared to do
   * something and did nothing.
   */
  const closeQuery = useCallback(async (id: string) => {
    const query = queriesRef.current.find((q) => q.id === id);
    if (!query || query.closed) return { ok: false as const };

    // Evidence in hand means somebody already did the walking, so the money
    // is no longer the asker's to take back.
    const job = tasksRef.current.find((t) => t.fromQueryId === id);
    if (job?.status === 'completed') {
      return { ok: false as const, detail: 'An answer already came back.' };
    }

    /**
     * Nor is a query the asker's to end by refunding it.
     *
     * The server refuses this too; refusing here as well keeps the local
     * ledger from showing a refund the database never wrote.
     */
    if (taskPhase(query.taskStatus) === 'queried') {
      return { ok: false as const, detail: 'A reviewer decides this one.' };
    }

    setQueries((prev) => prev.map((q) => (q.id === id ? { ...q, closed: true } : q)));

    // Pull the job off the board so nobody sets out for money that has gone.
    setNearbyTasks((prev) => prev.filter((t) => t.fromQueryId !== id));

    if (hasApi) {
      const query2 = queriesRef.current.find((q) => q.id === id);
      const serverId = query2?.serverId;
      if (serverId) {
        const closed = await closeQuestionOnServer(serverId);
        if (!closed.ok) {
          // Put it back rather than leaving a question this device alone
          // believes is closed and refunded.
          setQueries((prev) => prev.map((q) => (q.id === id ? { ...q, closed: false } : q)));
          return { ok: false as const, detail: closed.detail };
        }
        void refreshWalletRef.current?.();
        void refreshMyQuestionsRef.current?.();
      }
    }

    setWalletHistory((prev) => [
      {
        id: `refund-${id}`,
        amount: query.bounty,
        description: `Refunded · "${query.question}"`,
        createdAt: Date.now(),
        pending: false,
        type: 'refund',
      },
      ...prev,
    ]);

    return { ok: true as const };
  }, []);

  const openDispute = useCallback(
    (input: {
      queryId: string;
      taskId: string | null;
      question: string;
      placeName: string;
      bounty: number;
      verifierName: string;
      reason: string;
      evidence: { kind: 'photo' | 'video'; detail: string };
    }) => {
      setDisputes((prev) => {
        if (prev.some((d) => d.queryId === input.queryId)) return prev;
        return [
          {
            id: `d-${input.queryId}`,
            queryId: input.queryId,
            taskId: input.taskId,
            question: input.question,
            placeName: input.placeName,
            bounty: input.bounty,
            askerName: firstNameFrom(user?.email),
            askerReason: input.reason,
            // openDispute is only ever reached from the tracking screen, which
            // is the asker's. A verifier's side of a dispute has to arrive from
            // the server, and no route serves one yet.
            answer: null,
            role: 'asker' as const,
            verifierName: input.verifierName,
            verifierReply: null,
            evidence: input.evidence,
            status: 'awaiting_verifier',
            adminNote: null,
            createdAt: Date.now(),
          },
          ...prev,
        ];
      });
    },
    [user?.email],
  );

  /**
   * Sends the verifier's side to the server, not just to this screen.
   *
   * This only ever wrote to local state. The route and the API function both
   * existed and neither was called, so the reply survived exactly until
   * refreshDisputes replaced the list with the server's copy — which had no
   * reply — and the verifier was asked to write it again. Every time.
   */
  const replyToDispute = useCallback(async (id: string, reply: string) => {
    const dispute = disputesRef.current.find((d) => d.id === id);
    if (!dispute || dispute.status !== 'awaiting_verifier') return { ok: false as const };

    // Optimistic, so the card changes under their hand rather than after a
    // round trip. Reconciled by the refresh either way.
    setDisputes((prev) =>
      prev.map((d) =>
        d.id === id ? { ...d, verifierReply: reply, status: 'awaiting_admin' } : d,
      ),
    );

    if (!hasApi) return { ok: true as const };

    // Keyed by the question, which is what the route matches on.
    const sent = await replyToDisputeOnServer(dispute.queryId, reply);
    if (!sent.ok) {
      // Put it back rather than leaving a reply that only this device believes.
      setDisputes((prev) =>
        prev.map((d) =>
          d.id === id ? { ...d, verifierReply: null, status: 'awaiting_verifier' } : d,
        ),
      );
      return { ok: false as const, detail: sent.detail };
    }
    return { ok: true as const };
  }, []);

  const resolveDispute = useCallback(
    (id: string, winner: 'asker' | 'verifier', note: string) => {
      const dispute = disputesRef.current.find((d) => d.id === id);
      if (!dispute || dispute.status.startsWith('resolved')) return;

      setDisputes((prev) =>
        prev.map((d) =>
          d.id === id
            ? {
                ...d,
                status: winner === 'asker' ? 'resolved_asker' : 'resolved_verifier',
                adminNote: note.trim() || null,
              }
            : d,
        ),
      );

      // The held money has been sitting since dispatch. It moves now, once.
      if (winner === 'asker') {
        setWalletHistory((prev) => [
          {
            id: `dispute-refund-${id}`,
            amount: dispute.bounty,
            description: `Dispute upheld · "${dispute.question}"`,
            createdAt: Date.now(),
            pending: false,
            type: 'refund',
          },
          ...prev,
        ]);
        setQueries((prev) =>
          prev.map((q) => (q.id === dispute.queryId ? { ...q, closed: true } : q)),
        );
        if (dispute.taskId) {
          setNearbyTasks((prev) => prev.filter((t) => t.id !== dispute.taskId));
        }
      } else if (dispute.taskId) {
        setNearbyTasks((prev) =>
          prev.map((t) => (t.id === dispute.taskId ? { ...t, status: 'completed' as const } : t)),
        );
      }
    },
    [],
  );

  const tipVerifier = useCallback((amount: number, verifierName: string) => {
    setWalletHistory((prev) => [
      {
        id: `tip-${Date.now()}`,
        amount,
        description: `Tip to ${verifierName}`,
        createdAt: Date.now(),
        pending: false,
        type: 'tip',
      },
      ...prev,
    ]);
  }, []);

  const acceptTask = useCallback(
    async (taskId: string, at: { lat: number; lng: number; where?: string | null }) => {
    /**
     * Claim it on the server first.
     *
     * The unique constraint on tasks.question_id is what actually decides who
     * got there first — without this call two people both see "accepted" on
     * their own device and both walk to the same place, and only one can be
     * paid.
     */
    if (!hasApi) return { ok: true };

    const result = await acceptJobOnServer(taskId, at);
    if (!result.ok) {
      /**
       * Refused, and the reason is now handed back rather than logged.
       *
       * These used to be dropped off the board on any failure, which is right
       * for "somebody else got it" and wrong for "you are too far away" — the
       * job is still there and still available, just not to you from here.
       * Only remove it when it has genuinely gone.
       */
      if (result.code !== 'too_far' && result.code !== 'location_required') {
        setNearbyTasks((prev) => prev.filter((t) => t.id !== taskId));
      }
      return { ok: false, detail: result.detail };
    }

    /**
     * Into the taken pile now, carrying the task id the server just issued.
     *
     * This existed and never ran: it sat after the return above, so the job
     * only reached `myJobs` when the refresh landed a moment later. The task
     * screen prefers the taken copy and falls back to the board's, and the
     * board's has no task id — so anybody who accepted a job and recorded
     * straight away submitted evidence with nowhere to be filed. The asker
     * got an answer with no media, and because the on-chain claim records
     * nobody without it, the escrow could not be released at all.
     *
     * Copying the board's entry would not have been enough either. It has
     * `taskId: null` by construction, since /questions/nearby has no task to
     * report. The id has to come from the accept response, which is the first
     * moment a task exists.
     */
    setNearbyTasks((prev) => {
      const job = prev.find((t) => t.id === taskId);
      if (job) {
        setMyJobs((mine) =>
          mine.some((m) => m.id === taskId)
            ? mine
            : [
                {
                  ...job,
                  status: 'accepted' as const,
                  taskId: result.data.taskId,
                  serverStatus: 'accepted',
                },
                ...mine,
              ],
        );
      }
      return prev.map((t) => (t.id === taskId ? { ...t, status: 'accepted' as const } : t));
    });

    // Both lists: it leaves the board and joins the taken pile. Without the
    // second call the job disappears entirely the moment /nearby drops it.
    void refreshJobs();
    void refreshMyJobs();
    return { ok: true };
  }, []);

  /**
   * Gives a taken job back to the board.
   *
   * Both lists move: it leaves the taken pile and rejoins the board. Doing
   * only the first would make it vanish from the verifier's app while still
   * being invisible to everybody else until the next refresh.
   */
  const abandonTask = useCallback(async (taskId: string) => {
    if (!hasApi) return { ok: true as const };

    const gone = await abandonJob(taskId);
    if (!gone.ok) return { ok: false as const, detail: gone.detail };

    setMyJobs((mine) => mine.filter((t) => t.id !== taskId));
    void refreshJobs();
    void refreshMyJobs();
    return { ok: true as const };
  }, []);

  const completeTask = useCallback((taskId: string, reward: number, description: string) => {
    setNearbyTasks((prev) =>
      prev.map((t) => (t.id === taskId ? { ...t, status: 'completed' as const } : t)),
    );
    const id = Date.now().toString();
    setWalletHistory((prev) => [
      { id, amount: reward, description, createdAt: Date.now(), pending: false, type: 'earning' },
      ...prev,
    ]);
  }, []);

  return (
    <AppContext.Provider
      value={{
        user, identity, refreshIdentity, registerSignOut, registerSigner, wallet, setWallet, locationFilter,
        homeArea, setHomeArea, profile, updateProfile, onboarded, finishOnboarding,
        accountLoaded, setAccountLoaded,
        jobsDone, questionsAsked, totalDepositedUsdc, walletLoaded, refreshWallet,
        alertPrefs, setAlertPref, applyPreferences,
        answersPublicByDefault, setAnswersPublicByDefault: setAnswersPublic,
        // Open jobs double as "questions nearby": both are other people's
        // real questions, seen from the two sides of the same list.
        questionsNearby: nearbyTasks.map((t) => ({
          id: t.id,
          text: t.title,
          area: t.area,
          state: stateForArea(t.area) ?? '',
          placeName: t.location,
        })),
        answeredNearby: forArea(answeredFeed, homeArea),
        myJobs, refreshMyJobs, refreshMyQuestions,
        recentPlaces, recentQuestions,
        dispatchError, clearDispatchError,
        refreshJobs,
        refreshDisputes,
        refreshAnswered,
        refreshNotifications,
        feedLoaded,

        // Only paid questions: an unpaid one has nobody working on it and so
        // has nothing to follow.
        /**
         * Still going, versus finished.
         *
         * A refunded or paid-out question has nothing left to do, so it moves
         * to History rather than sitting at the top of Ask looking live.
         */
        /**
         * Still yours to do something about — including the ones where the
         * something is confirming evidence somebody already sent.
         */
        activeQuestions: paidQuestions.filter(
          (q) => !q.closed && q.status !== 'answered' && q.status !== 'refunded',
        ),
        /**
         * Finished. 'delivered' deliberately is not here: evidence arriving is
         * not the asker agreeing with it, and History is for what is over.
         */
        answeredQuestions: paidQuestions.filter(
          (q) => q.closed || q.status === 'answered' || q.status === 'refunded',
        ),

        // From the taken pile, not the board. A job leaves `nearbyTasks` when
        // it is accepted, so filtering that list for accepted ones found
        // nothing — which is why My jobs was always empty.
        // Anything not yet confirmed is still the verifier's to watch —
        // accepted and waiting to be done, or submitted and waiting to be paid.
        // Working or delivered only. A queried job is finished work under
        // review, and a settled one is done; neither is something to go and
        // finish, and listing them here put the same task on Earn twice.
        activeJobs: myJobs.filter((t) => isVerifierActive(taskPhase(t.serverStatus))),
        completedJobs: myJobs.filter((t) => isFinished(taskPhase(t.serverStatus))),
        /**
         * Split out so the earner can see the shape of their work, the way the
         * asker can. 'delivered' is waiting on somebody else, 'queried' is with
         * a reviewer — neither is something to go and finish, and lumping them
         * under one "active" heading is what made a queried job look like it
         * still needed doing.
         */
        deliveredJobs: myJobs.filter((t) => taskPhase(t.serverStatus) === 'delivered'),
        queriedJobs: myJobs.filter((t) => taskPhase(t.serverStatus) === 'queried'),
        notifications,
        unreadCount: notifications.filter((n) => !n.read).length,
        markNotificationRead,
        markAllNotificationsRead,
        queries, nearbyTasks,
        walletBalance, pendingBalance,
        walletHistory: walletHistory.filter((e) => !e.pending),
        usdcBalance, balanceBlock, ngnPerUsd, refreshBalance,
        signIn, signOut, submitNin,
        setLocationFilter, depositUsdc, withdrawUsdc,
        addQuery, dispatchQuery, closeQuery, tipVerifier, acceptTask, abandonTask, completeTask,
        disputes, openDispute, replyToDispute, resolveDispute,
        disputeForQuery: (queryId: string) =>
          disputes.find((d) => d.queryId === queryId) ?? null,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
