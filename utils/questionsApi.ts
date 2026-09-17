import { apiFetch, hasApi } from './api';
import { WALLET_MODE } from '@/utils/privyShared';

/**
 * The Ask and Earn loop, over the wire.
 *
 * Amounts cross in kobo and are converted once, here, so no screen has to
 * remember which side of the boundary it is on.
 */
const toNaira = (kobo: number): number => kobo / 100;

export type ServerQuestion = {
  id: string;
  text: string;
  bountyKobo: number;
  deadlineMinutes: number;
  /** When the question was asked. The only field History can order on. */
  createdAt: string;
  dispatchedAt: string | null;
  closedAt: string | null;
  verifiedOnly: boolean;
  visibility: 'public' | 'private';
  placeName: string | null;
  area: string | null;
  state: string | null;
  taskId: string | null;
  taskStatus: string | null;
  verifierName: string | null;
  answer: string | null;
  evidenceKind: 'photo' | 'video' | null;
  /** Server path to the file, ready to be made absolute with mediaUrl(). */
  evidenceUrl: string | null;
  /**
   * Every file from the attempt. `evidenceUrl` is the first of them, kept for
   * the places that want one representative image rather than a gallery.
   */
  evidenceUrls: string[];
  distanceMetres: number | null;
  disputeStatus: string | null;
  /**
   * Set when the verifier sent this over a check that objected: 'warn' or
   * 'fail'. Null when the gate passed it cleanly, which is the normal case.
   */
  sentPastCheck: 'warn' | 'fail' | null;
  minutesLeft: number;
};

export type ServerJob = {
  id: string;
  text: string;
  bountyKobo: number;
  deadlineMinutes: number;
  verifiedOnly: boolean;
  placeName: string | null;
  area: string | null;
  state: string | null;
  askerName: string | null;
  category: 'fuel' | 'food' | 'traffic' | 'shopping' | 'safety';
  minutesLeft: number;
};

export type ServerAnswered = {
  id: string;
  text: string;
  area: string;
  state: string;
  proof: 'photo' | 'video';
  confirmed: boolean;
  ago: string;
};

export type ServerNotification = {
  kind: string;
  id: string;
  at: string;
  title: string;
  body: string | null;
  href: string | null;
};

export type DispatchInput = {
  text: string;
  placeName: string;
  area: string | null;
  state: string | null;
  lat?: number | null;
  lng?: number | null;
  bounty: number;
  deadlineMinutes: number;
  visibility: 'public' | 'private';
  verifiedOnly: boolean;
};

export const dispatchQuestion = (input: DispatchInput) =>
  /**
   * `needsFunding` is true when an escrow contract is configured. The question
   * exists but is not yet a job anybody can see — funding it is what
   * dispatches it.
   */
  /*
   * The chain travels with the request, because the server checks whether this
   * person can actually pay before it writes anything down. A mini app asker's
   * money is USDT on Polygon, and a check against Base would refuse every
   * question they ask against a balance they were never going to use.
   */
  apiFetch<{ id: string; createdAt: string; needsFunding: boolean }>(
    WALLET_MODE ? '/questions?chain=polygon' : '/questions',
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );

export const myQuestions = () => apiFetch<{ questions: ServerQuestion[] }>('/questions/mine');

export const nearbyJobs = (area?: string) =>
  apiFetch<{ jobs: ServerJob[] }>(`/questions/nearby${area ? `?area=${encodeURIComponent(area)}` : ''}`);

/** Jobs this person has taken. Never in the nearby list — that excludes them. */
export type ServerDispute = {
  id: string;
  status: string;
  askerReason: string;
  verifierReply: string | null;
  adminNote: string | null;
  createdAt: string;
  questionId: string;
  question: string;
  bountyKobo: number;
  placeName: string | null;
  askerName: string | null;
  verifierName: string | null;
  evidenceKind: 'photo' | 'video' | null;
  evidenceUrl: string | null;
  /**
   * Every file from the attempt. `evidenceUrl` is the first of them, kept for
   * the places that want one representative image rather than a gallery.
   */
  evidenceUrls: string[];
  /** What the verifier wrote when they sent the evidence. */
  answer: string | null;
  /** Which side of it you are on, decided by the server from the rows. */
  role: 'asker' | 'verifier';
};

/** Disputes you are a party to, either side. */
export const myDisputes = () =>
  apiFetch<{ disputes: ServerDispute[] }>('/questions/disputes/mine');

export const takenJobs = () =>
  apiFetch<{
    jobs: (ServerJob & {
      taskId: string;
      taskStatus: string;
      answer: string | null;
      /** Null when the on-chain claim never landed — no claim, no payment. */
      claimTx: string | null;
      chainJobId: string | null;
    })[];
  }>('/questions/taken');

export const answeredNearby = () => apiFetch<{ answered: ServerAnswered[] }>('/questions/answered');

/**
 * Takes a job, and proves where you were when you took it.
 *
 * The coordinates are not optional decoration: the server refuses the job
 * without them, because "I am near this place" is the one claim it cannot take
 * on trust from a device.
 */
export const acceptJob = (
  id: string,
  at: { lat: number; lng: number; where?: string | null },
) =>
  apiFetch<{ taskId: string }>(`/questions/${id}/accept`, {
    method: 'POST',
    // `where` is the reverse-geocoded name of the fix, sent so the server can
    // judge an area the way a person would. A place like "Oredo" is a whole
    // LGA and its stored point is only the middle of it.
    body: JSON.stringify({ lat: at.lat, lng: at.lng, where: at.where ?? null }),
  });

export const submitAnswer = (
  id: string,
  input: {
    answer: string;
    evidenceKind?: 'photo' | 'video';
    storageKey?: string;
    lat?: number | null;
    lng?: number | null;
    distanceMetres?: number | null;
  },
) => apiFetch<{ ok: true }>(`/questions/${id}/submit`, { method: 'POST', body: JSON.stringify(input) });

export const confirmAnswer = (id: string) =>
  apiFetch<{ ok: true; paidKobo: number }>(`/questions/${id}/confirm`, { method: 'POST' });

export const closeQuestion = (id: string) =>
  apiFetch<{ ok: true; refundedKobo: number }>(`/questions/${id}/close`, { method: 'POST' });

export const fetchNotifications = () =>
  apiFetch<{ notifications: ServerNotification[] }>('/questions/notifications');

export type CachedAnswerPayload = {
  question: string;
  answer: string;
  placeName: string;
  area: string | null;
  proof: 'photo' | 'video';
  hoursOld: number;
};

export const cachedAnswerFor = (place: string) =>
  apiFetch<{ answer: CachedAnswerPayload | null }>(
    `/questions/cached?place=${encodeURIComponent(place)}`,
  );

/**
 * Whether the network already knows the answer, before anybody is sent.
 *
 * Replaces `cachedAnswerFor`, which matched on place name alone and so offered
 * an answer about a road to somebody asking about a market. This asks the
 * server to judge the old question against the new one and its age, and
 * returns nothing rather than something unrelated.
 *
 * Silent on failure by design: a person asking a question must never be
 * blocked because a convenience did not load. No answer means the ordinary
 * path, which is what happened every time before this existed.
 */
export type KnownAnswer = {
  id: string;
  placeName: string;
  area: string;
  answer: string;
  detail: string;
  proof: 'photo' | 'video';
  confirmed: boolean;
  ageHours: number;
  ageMinutes: number;
  /** "20 minutes ago", "6 hours ago" — said rather than rounded. */
  ageLabel: string;
  verifierName: string;
  verifierInitials: string;
  visibility: 'public';
  evidence: string[];
};

export const checkIfKnown = (
  question: string,
  place: string,
  at?: { lat: number; lng: number } | null,
) =>
  apiFetch<{ known: boolean; because?: string; answer?: KnownAnswer }>('/agent/check', {
    method: 'POST',
    body: JSON.stringify({ question, place, lat: at?.lat ?? null, lng: at?.lng ?? null }),
  });

/**
 * Pays a verifier again for an answer that was reused.
 *
 * The app had a `tipVerifier` that appended a row to local wallet history and
 * nothing else — the verifier was never paid and the entry disappeared on
 * reload. This is the call that actually moves it.
 */
export type KnownHere = {
  id: string;
  question: string;
  answer: string;
  ageLabel: string;
  ageMinutes: number;
  verifier: string | null;
  confirmed: boolean;
  proof: 'photo' | 'video' | null;
  evidence: string[];
};

/**
 * What the network already holds for a place, before anybody commits.
 *
 * Inventory rather than judgment: no question has been asked yet, so there is
 * nothing to weigh relevance against. It exists so somebody can see whether a
 * place has ever been visited before deciding it is worth ₦500 — which the app
 * could not tell them at all.
 */
export const knownHere = (place: string, at?: { lat: number; lng: number } | null) =>
  apiFetch<{ place: string; count: number; answers: KnownHere[] }>(
    `/agent/known?place=${encodeURIComponent(place)}` +
      (at ? `&lat=${at.lat}&lng=${at.lng}` : ''),
  );

export const tipForAnswer = (questionId: string, amountNgn: number) =>
  apiFetch<{ ok: true; amountNgn: number; verifier: string | null }>(
    `/questions/${questionId}/tip`,
    { method: 'POST', body: JSON.stringify({ amountNgn }) },
  );

/**
 * Keys that let a program act as you.
 *
 * The routes have existed since the agent surface was built and nothing in the
 * app ever called them, so the only way to get a key was a wallet signature on
 * the web page. Somebody already signed in here should not have to go
 * somewhere else and prove who they are a second time.
 */
export type AgentKey = {
  id: string;
  name: string;
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export const listAgentKeys = () => apiFetch<{ keys: AgentKey[] }>('/agent/keys');

export const createAgentKey = (name: string) =>
  apiFetch<{ id: string; name: string; token: string; warning: string }>('/agent/keys', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });

export const revokeAgentKey = (id: string) =>
  apiFetch<{ ok: true }>(`/agent/keys/${id}`, { method: 'DELETE' });

export { hasApi, toNaira };

/** Records a query against an answer, so a reviewer can see it. */
export const openDisputeOnServer = (id: string, reason: string) =>
  apiFetch<{ ok: true; id: string }>(`/questions/${id}/dispute`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });

/**
 * Corrects the writing in a question, without changing what it asks.
 *
 * Returns the text unchanged when the server has no model configured, so a
 * caller can treat "no change" and "nothing needed" as the same outcome and
 * fall back to the local pass either way.
 */
export const tidyOnServer = (text: string) =>
  apiFetch<{ text: string; changed: boolean; limited?: boolean }>('/tidy', {
    method: 'POST',
    body: JSON.stringify({ text }),
  });

/** Hands a job back to the board. The verifier's own escape hatch. */
export const abandonJob = (id: string) =>
  apiFetch<{ ok: true }>(`/questions/${id}/abandon`, { method: 'POST' });

/** Back on the board, clock restarted. The asker's alternative to a refund. */
export const relistQuestion = (id: string) =>
  apiFetch<{ ok: true }>(`/questions/${id}/relist`, { method: 'POST' });

/** The verifier's side of it. */
export const replyToDisputeOnServer = (id: string, reply: string) =>
  apiFetch<{ ok: true }>(`/questions/${id}/dispute/reply`, {
    method: 'POST',
    body: JSON.stringify({ reply }),
  });
