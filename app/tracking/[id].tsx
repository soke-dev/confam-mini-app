import React, { useEffect, useRef, useState } from 'react';
import {
  Modal, ActivityIndicator, Animated, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { useColors, type Theme } from '@/hooks/useColors';
import { hasEvidence, isFinished, isTaken, taskPhase } from '@/utils/taskPhase';
import { useDialog } from '@/contexts/DialogContext';
import { font, text } from '@/constants/type';
import { formatNaira, verifierCut } from '@/constants/money';
import { formatDuration, formatRemaining, msUntilDeadline } from '@/constants/time';
import { useApp } from '@/contexts/AppContext';
import {
  confirmAnswer,
  myQuestions,
  openDisputeOnServer,
  relistQuestion,
} from '@/utils/questionsApi';
import { mediaUrl } from '@/utils/api';
import { formatDistance } from '@/utils/evidenceChecks';
import { disputeJob, escrowAvailable, refundJob, releaseJob } from '@/utils/escrowApi';
import { SendingIndicator } from '@/components/SendingIndicator';
import { useSignAuthorization } from '@/utils/privy';
import { useRealtime, useRealtimeStatus } from '@/hooks/useRealtime';
import { VerificationCard, Verification } from '@/components/VerificationCard';

type EvidenceAction = 'confirm' | 'query' | null;

/**
 * One job locks to one verifier, so exactly one answer comes back. Several
 * people may be offered the job, but only whoever accepts it first walks
 * anywhere — and only they get paid.
 */
/**
 * An empty answer, until the server sends a real one.
 *
 * This used to be a complete fabricated response — a verifier called Akin with
 * 218 jobs, standing 0.3km away, reporting ₦895 per litre. It rendered in the
 * same card as a real answer with nothing to distinguish it, so the tracking
 * screen showed an answer to a question nobody had gone and checked.
 */
const EMPTY_RESPONSE: Verification & { id: string } = {
  id: '',
  workerInitials: '',
  workerName: '',
  response: '',
  detail: '',
  timeAgo: '',
  distance: '',
  mediaType: 'photo',
  status: 'pending',
  idVerified: false,
  jobsDone: 0,
  capturedAt: '',
  capturedNear: '',
  duration: '',
  checks: [],
};


function Pulse({ color, size = 8 }: { color: string; size?: number }) {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.18, duration: 640, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 640, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [opacity]);
  return (
    <Animated.View
      style={{ opacity, width: size, height: size, borderRadius: 1, backgroundColor: color }}
    />
  );
}

/**
 * A schematic "map" — a survey grid with a signal ping, not a fake satellite
 * tile.
 *
 * The ping only sweeps while the question is still running. It means "we are
 * waiting to hear something about this place", and on a job that was answered
 * and paid days ago there is nothing left to hear: a settled question in
 * History sat there pulsing as though something were still happening.
 */
function GroundMap({ colors, label, live }: { colors: Theme; label: string; live: boolean }) {
  const ring = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!live) {
      // Parked at rest rather than mid-sweep, so a settled map is not frozen
      // halfway through an expanding ring.
      ring.setValue(0);
      return;
    }

    const anim = Animated.loop(
      Animated.timing(ring, { toValue: 1, duration: 2400, useNativeDriver: true }),
    );
    anim.start();
    return () => anim.stop();
  }, [ring, live]);

  return (
    <View style={[map.wrap, { backgroundColor: colors.sunken, borderColor: colors.border }]}>
      {[0.2, 0.4, 0.6, 0.8].map((f) => (
        <View key={`h${f}`} style={[map.rule, { top: `${f * 100}%`, backgroundColor: colors.border }]} />
      ))}
      {[0.25, 0.5, 0.75].map((f) => (
        <View
          key={`v${f}`}
          style={[map.ruleV, { left: `${f * 100}%`, backgroundColor: colors.border }]}
        />
      ))}

      <View style={map.center}>
        <Animated.View
          style={[
            map.ripple,
            {
              borderColor: colors.accent,
              opacity: ring.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }),
              transform: [
                { scale: ring.interpolate({ inputRange: [0, 1], outputRange: [1, 2.4] }) },
              ],
            },
          ]}
        />
        <View style={[map.pin, { backgroundColor: colors.accent }]}>
          <Ionicons name="location" size={13} color={colors.accentForeground} />
        </View>
      </View>

      <View style={[map.tag, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[text.data, { color: colors.foreground }]} numberOfLines={1}>
          {label}
        </Text>
      </View>

      <View style={[map.walker, { backgroundColor: colors.primary, top: '28%', left: '30%' }]} />
      <View style={[map.walker, { backgroundColor: colors.primary, top: '64%', left: '68%' }]} />
    </View>
  );
}

const map = StyleSheet.create({
  wrap: {
    height: 168,
    borderRadius: 2,
    borderWidth: 2,
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 18,
  },
  rule: { position: 'absolute', left: 0, right: 0, height: 1, opacity: 0.7 },
  ruleV: { position: 'absolute', top: 0, bottom: 0, width: 1, opacity: 0.7 },
  center: { alignItems: 'center', justifyContent: 'center' },
  ripple: { position: 'absolute', width: 54, height: 54, borderRadius: 2, borderWidth: 2 },
  pin: { width: 30, height: 30, borderRadius: 2, alignItems: 'center', justifyContent: 'center' },
  tag: {
    position: 'absolute',
    bottom: 10,
    left: 10,
    borderWidth: 2,
    borderRadius: 2,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  walker: { position: 'absolute', width: 7, height: 7, borderRadius: 2 },
});

/**
 * Where a question stands, from what app state already knows about it.
 *
 * Mirrors the ladder the loader walks: taken, then delivered, then paid. Note
 * `showFinal` follows `confirmed` only and never `closed` — a refunded
 * question is finished, but "Answer settled · paid" would be a lie about it.
 */
function seedFrom(query: { taskStatus?: string | null; verifierName?: string | null } | undefined) {
  const phase = taskPhase(query?.taskStatus);

  const confirmed = isFinished(phase);
  const delivered = hasEvidence(phase);
  const taken = isTaken(phase);

  return {
    // Queried sits at the asker's step: evidence is in and the ruling is what
    // is outstanding, even though a reviewer now makes it rather than them.
    stepIndex: confirmed ? 3 : delivered ? 2 : taken ? 1 : 0,
    shown: delivered,
    showFinal: confirmed,
    taken,
    confirmed,
    // Only once somebody has actually taken it. Naming a verifier on a job
    // nobody has picked up would be the same class of lie in the other
    // direction.
    workerName: taken ? (query?.verifierName ?? '') : '',
  };
}

export default function TrackingScreen() {
  const colors = useColors();
  const { confirm, notify } = useDialog();
  /**
   * True from the tap until the refund has actually happened.
   *
   * Closing does a server call and an on-chain refund, and the screen was
   * re-rendering underneath as each landed — the question flipping to closed,
   * the steps rearranging, the window disappearing — before the dialog finally
   * arrived to explain it. Saying "closing" first turns that into one wait
   * instead of a sequence of jumps.
   */
  const [closing, setClosing] = useState(false);
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const {
    queries,
    closeQuery,
    openDispute,
    disputeForQuery,
    refreshWallet,
    refreshMyQuestions,
    refreshBalance,
    dispatchError,
    clearDispatchError,
  } = useApp();
  const signAuthorization = useSignAuthorization();
  /**
   * Set when the answer was accepted but the money did not move.
   *
   * Distinct from a failed confirmation: the decision stands, and saying
   * nothing would leave somebody believing a verifier had been paid when the
   * transfer never happened.
   */
  const [settleError, setSettleError] = useState<string | null>(null);
  /**
   * From the confirm tap until the verifier is actually paid.
   *
   * Covers a ledger write, a wallet signature and a relayed transaction. Long
   * enough that a screen doing nothing reads as a dropped tap.
   */
  const [settling, setSettling] = useState(false);

  /**
   * Everything about this question arrives on one topic — the task being
   * taken, the evidence landing, the dispute being answered — because the
   * database triggers route it all there.
   *
   * The handler is empty on purpose. This screen still renders from local
   * context, so there is nothing to pull yet; it gets a body when the screens
   * start reading through the API. Subscribing now is what puts the topic on
   * the socket, and keeps the connection indicator honest about this screen.
   */
  const connection = useRealtimeStatus();
  useRealtime(id ? `question:${id}` : null, () => {});
  const topPad = Platform.OS === 'web' ? 22 : insets.top + 6;

  const query = queries.find((q) => q.id === id);
  const question = query?.question ?? 'Checking that location…';
  const place = query?.place ?? null;

  /**
   * Opens where the question already is, not at the beginning.
   *
   * `/questions/mine` reports `taskStatus`, so by the time History can list a
   * question app state already knows whether it was taken, delivered or paid.
   * Starting every flag at false threw that away and re-derived it from the
   * server, so a settled question opened as four empty checkboxes and filled
   * itself in a moment later.
   *
   * This is a starting position, not the truth: the loader below still asks
   * the server and corrects anything that has moved on since the last refresh.
   */
  const seed = seedFrom(query);

  const [stepIndex, setStepIndex] = useState(seed.stepIndex);
  const [shown, setShown] = useState(seed.shown);
  const [showFinal, setShowFinal] = useState(seed.showFinal);
  const [response, setResponse] = useState({ ...EMPTY_RESPONSE, workerName: seed.workerName });
  /** False until the server has said what came back, if anything. */
  const [answerLoaded, setAnswerLoaded] = useState(false);
  /**
   * Set when the verifier sent this over a check that objected.
   *
   * Shown to the asker before they decide. The gate can be overridden — a
   * blur score is wrong about a real dusk often enough that a wall there
   * costs honest verifiers real trips — and the price of letting it through
   * is that the person paying gets told it happened.
   */
  const [sentPastCheck, setSentPastCheck] = useState<'warn' | 'fail' | null>(null);
  /** Set by the loader when a verifier has actually taken the job. */
  const [taken, setTaken] = useState(seed.taken);
  const [action, setAction] = useState<EvidenceAction>(null);
  const [confirmed, setConfirmed] = useState(seed.confirmed);
  const fade = useRef(new Animated.Value(0)).current;

  // Ticks so the countdown moves and the refund offer appears the moment the
  // window closes, rather than on the next unrelated re-render.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const dispute = query ? disputeForQuery(query.id) : null;
  const msLeft = query ? msUntilDeadline(query.dispatchedAt, query.deadlineMinutes) : 0;
  /**
   * Unknown is not overdue.
   *
   * With no query loaded yet `msLeft` is 0, which read as a passed deadline —
   * so a question that had only just been sent showed the overdue banner and
   * hid the way out behind it.
   */
  /**
   * Past the deadline, and we have actually checked.
   *
   * `answerLoaded` matters as much as the clock. Without it the banner
   * declared "nobody delivered" in the gap between the question loading from
   * app state and the answer arriving from the server — announcing a failure
   * it had not looked for, on a job somebody may already have done.
   */
  const overdue = query !== null && answerLoaded && msLeft <= 0;

  // Whoever took it, or a neutral word until somebody has. An empty name
  // rendered as " took the job", which read like a bug and was one.
  const worker = response.workerName || 'Somebody';

  /**
   * Four steps, each a genuinely different state.
   *
   * There were five. "Offered to people nearby" and "Waiting for somebody to
   * take it" described the same moment — a question is offered *because*
   * nobody has taken it — so the tracker showed one state as two rows and
   * appeared stuck on the first.
   *
   * Each row now changes its own wording as it completes, rather than being
   * followed by another row saying the same thing differently.
   */
  /**
   * Nothing is live until the server has answered.
   *
   * Every flag below starts false, so an unloaded question rendered as "just
   * sent" — a settled one flashed through waiting, evidence and your-turn on
   * its way to the truth. A moment of nothing is better than a moment of
   * something wrong.
   */
  /**
   * A question app state already holds is known enough to draw.
   *
   * This was `answerLoaded` alone, which meant "the server has replied to this
   * screen" — but arriving from History the status is already in hand, and
   * waiting for a second confirmation of it is what produced the blank
   * checklist. A question we have never seen still waits.
   */
  const known = answerLoaded || Boolean(query);

  /** Nothing further will happen to this question. */
  const settled = confirmed || showFinal || Boolean(query?.closed);

  /**
   * Closed with the money returned, rather than paid out.
   *
   * `settled` covers every way a question ends and so cannot describe any of
   * them. A refunded question has no verifier, no evidence and no payment, so
   * the four progress steps have nothing to say about it — and rendering them
   * empty made a finished question read as one that had only just been sent.
   */
  const refunded = Boolean(query?.closed) && !confirmed && !shown;

  const STEPS = [
    {
      label: taken ? `${worker} took it` : 'Waiting for somebody to take it',
      sub: taken ? 'Locked to them until the deadline' : 'Anyone nearby can take it',
      done: stepIndex > 0,
      live: known && stepIndex === 0,
    },
    {
      label: shown ? 'Evidence came back' : 'Waiting on evidence',
      sub: shown ? `${response.mediaType} proof sent` : 'They have until the deadline',
      done: stepIndex > 1,
      live: known && stepIndex === 1,
    },
    {
      label: 'Your turn to check it',
      sub: 'Confirm it or query it',
      done: confirmed,
      live: known && stepIndex === 2 && !confirmed,
    },
    {
      label: 'Answer settled',
      sub: `${worker} paid`,
      done: showFinal,
      live: known && stepIndex === 3 && !showFinal,
    },
  ];
;

  /**
   * The progress steps used to run on a timer.
   *
   * Four setTimeouts marched the tracker from "sent" to "your turn to check
   * it" over six seconds and revealed the answer card at 5.2s — whether or not
   * anybody had taken the job, gone anywhere, or sent anything. It looked
   * exactly like a real delivery.
   *
   * The steps now follow what the server reports, which is why they can also
   * sit still for an hour: that is what waiting for somebody to walk somewhere
   * actually looks like.
   */

  useEffect(() => {
    if (confirmed && !showFinal) {
      const t = setTimeout(() => setShowFinal(true), 700);
      return () => clearTimeout(t);
    }
  }, [confirmed, showFinal]);

  /**
   * Accepts the answer and pays for it.
   *
   * The screen advances first because confirming is irreversible and the
   * person has already been warned — making them watch a spinner after the
   * decision adds nothing. What follows is the money actually moving.
   */
  /**
   * Reads what actually came back for this question.
   *
   * Polled while the answer is outstanding, because a verifier submits on
   * their own schedule and the asker is sitting on this screen waiting. It
   * stops once something has arrived — there is nothing further to wait for.
   */
  const serverId = query?.serverId ?? null;

  useEffect(() => {
    if (!serverId) return;
    let stopped = false;

    async function load() {
      const result = await myQuestions();
      if (!result.ok || stopped) return;

      // Matched on the server id, which is what /questions/mine returns.
      const mine = result.data.questions.find((q) => q.id === serverId);
      setAnswerLoaded(true);
      if (!mine) return;

      // Somebody has taken it, even if they have not sent anything yet.
      if (mine.taskId) {
        setTaken(true);
        setStepIndex((prev) => Math.max(prev, 1));
      }

      const submitted = mine.taskStatus === 'submitted' || mine.taskStatus === 'confirmed';
      if (!submitted || !mine.answer) return;

      setSentPastCheck(mine.sentPastCheck ?? null);

      // Only now is there something to show.
      setShown(true);
      setStepIndex((prev) => Math.max(prev, 2));

      /**
       * A settled job reads as settled, on any device.
       *
       * `confirmed` and `showFinal` were only ever set by the confirm button,
       * so they lived and died with that one session. Reloading showed a paid,
       * closed question still sitting on "Your turn to check it" — asking
       * somebody to decide something they had already decided.
       */
      if (mine.taskStatus === 'confirmed') {
        setConfirmed(true);
        setShowFinal(true);
        setStepIndex(3);
      }

      const name = mine.verifierName ?? 'A verifier';
      setResponse((prev) => ({
        ...prev,
        id: mine.taskId ?? '',
        workerName: name,
        workerInitials: name.slice(0, 2).toUpperCase(),
        response: mine.answer ?? '',
        // Deliberately blank rather than padded with detail we do not have.
        detail: '',
        mediaType: mine.evidenceKind === 'video' ? 'video' : 'photo',
        // Absolute, so the app can actually load it.
        mediaUri: mediaUrl(mine.evidenceUrl),
        /**
         * All of them, not just the first.
         *
         * A submission can carry up to five photos and the card only ever had
         * one to show, so an asker who was sent two saw one and had no way to
         * know the other was there.
         */
        mediaUris: mine.evidenceUrls
          .map((u) => mediaUrl(u))
          .filter((u): u is string => Boolean(u)),
        status: mine.taskStatus === 'confirmed' ? 'confirmed' : 'pending',
        capturedNear:
          mine.distanceMetres !== null
            ? `${mine.distanceMetres} m from ${mine.placeName ?? 'the place'}`
            : '',
        distance: mine.distanceMetres !== null ? formatDistance(mine.distanceMetres) : '',
      }));
    }

    void load();
    const timer = setInterval(load, 10_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [serverId]);

  /**
   * Pay the verifier, and only then say they have been paid.
   *
   * This used to mark the question confirmed and run the paid animation on the
   * first line, before the ledger, before the signature and before the
   * release. On a phone the embedded wallet signs without a prompt and the gap
   * was invisible. In a wallet host the confirmation screen appeared first and
   * the wallet asked afterwards — so somebody was shown that they had paid,
   * and then asked whether they wanted to, with the screen already claiming
   * they had.
   *
   * The settling overlay covers the wait, which is a signature and a relayed
   * transaction and can be several seconds.
   */
  function handleConfirm() {
    setAction('confirm');

    void (async () => {
      if (!query) return;

      if (!query.serverId) {
        setSettleError('This question never reached the server, so it cannot be settled.');
        return;
      }

      setSettling(true);
      try {
        // The ledger first: it is what every screen reads, and it settles
        // whether or not the job was ever funded on chain.
        const paid = await confirmAnswer(query.serverId);
        if (!paid.ok) {
          setSettleError(`Payment did not go through — ${paid.detail}`);
          return;
        }

        // Then the contract, when there is one. A ledger-only job is already
        // finished; releasing is what moves the real USDC when there is any.
        let chainFailed: string | null = null;
        if (await escrowAvailable()) {
          const released = await releaseJob(query.serverId, signAuthorization);
          if (!released.ok && released.code !== 'not_funded') {
            chainFailed =
              released.code === 'declined'
                ? 'Confirmed. Sign when you are ready to release the funds.'
                : `Confirmed, but the on-chain release failed — ${released.detail}`;
          }
        }

        /*
         * Marked confirmed either way, because the ledger settled — but the
         * chain failure is still said out loud. Money that moved in our
         * records and not in the contract is exactly the gap worth naming.
         */
        setResponse((v) => ({ ...v, status: 'confirmed' }));
        setConfirmed(true);
        setStepIndex(3);
        Animated.timing(fade, { toValue: 1, duration: 380, useNativeDriver: true }).start();
        if (chainFailed) setSettleError(chainFailed);

        await Promise.all([refreshWallet(), refreshBalance()]);
      } finally {
        setSettling(false);
      }
    })();
  }

  const settlingOverlay = (
    /*
     * Not dismissable: there is nothing useful a tap can do to a signature
     * already in front of somebody, and a backdrop that closed would look
     * like a way to cancel a payment it cannot call back.
     */
    <Modal visible={settling} transparent animationType="fade">
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.overlay,
          paddingHorizontal: 24,
        }}
      >
        <View
          style={{
            backgroundColor: colors.surface,
            borderColor: colors.border,
            borderWidth: 2,
            borderRadius: 2,
            paddingVertical: 22,
            paddingHorizontal: 20,
            width: '100%',
            maxWidth: 380,
            gap: 12,
          }}
        >
          <SendingIndicator label="Paying the verifier" color={colors.primary} />
          <Text style={[text.bodySmall, { color: colors.faintForeground }]}>
            Approve it in your wallet. The money moves when that is done.
          </Text>
        </View>
      </View>
    </Modal>
  );

  function handleQuery(reason: string) {
    if (!query) return;
    setAction('query');
    setResponse((v) => ({ ...v, status: 'queried' }));

    /**
     * Record it on the server first.
     *
     * The chain freeze and the local state were both happening already, but
     * nothing wrote it to Postgres — so the review desk had nothing to show
     * and the money stayed frozen with nobody able to decide it.
     */
    void (async () => {
      if (!query.serverId) return;
      const recorded = await openDisputeOnServer(query.serverId, reason);
      if (!recorded.ok && recorded.code !== 'already_disputed') {
        setSettleError(`Your query was not recorded — ${recorded.detail}`);
      }
    })();

    /**
     * Freeze it on chain as well, when the job is funded there.
     *
     * Without this the contract still thinks the job is claimed and its
     * deadline keeps running — so an asker could query an answer and have the
     * money released out from under the dispute.
     */
    void (async () => {
      if (!query.serverId || !(await escrowAvailable())) return;
      const frozen = await disputeJob(query.serverId, signAuthorization);
      if (!frozen.ok && frozen.code !== 'not_funded') {
        setSettleError(`The query was recorded, but the job is not frozen on chain — ${frozen.detail}`);
      }
    })();

    // Real record now, not a timer. It waits on the verifier, then a person.
    openDispute({
      queryId: query.id,
      taskId: null,
      question: query.question,
      placeName: query.place?.name ?? 'Unknown place',
      bounty: query.bounty,
      verifierName: response.workerName,
      reason,
      evidence: {
        kind: response.mediaType === 'video' ? 'video' : 'photo',
        detail: response.detail,
      },
    });
  }

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      {settlingOverlay}
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.scroll, { paddingTop: topPad }]}
      >
        <View style={styles.bar}>
          <Pressable
            onPress={() => router.back()}
            style={[styles.backBtn, { borderColor: colors.border }]}
          >
            <Ionicons name="arrow-back" size={18} color={colors.foreground} />
          </Pressable>
          {/* A finished question has nothing left to watch, so the whole
              connection indicator goes with it. "Live" on a settled job is
              true about the socket and misleading about the question, which
              is the thing somebody is actually looking at. */}
          {refunded ? (
            <View style={styles.liveTag}>
              <Ionicons name="arrow-undo-circle" size={13} color={colors.mutedForeground} />
              <Text style={[text.label, { color: colors.mutedForeground }]}>Refunded</Text>
            </View>
          ) : settled ? (
            <View style={styles.liveTag}>
              <Ionicons name="checkmark-circle" size={13} color={colors.primary} />
              <Text style={[text.label, { color: colors.primary }]}>Settled</Text>
            </View>
          ) : (
            <>
              {/* Only claims "Live" when a socket is genuinely open. With no
                  backend configured this shows nothing rather than a green dot
                  that means nothing. */}
              {connection === 'open' && (
                <View style={styles.liveTag}>
                  <Pulse color={colors.accent} />
                  <Text style={[text.label, { color: colors.accent }]}>Live</Text>
                </View>
              )}
              {connection === 'connecting' && (
                <Text style={[text.label, { color: colors.faintForeground }]}>Connecting…</Text>
              )}
              {connection === 'offline' && (
                <View style={styles.liveTag}>
                  <Ionicons name="cloud-offline-outline" size={13} color={colors.pending} />
                  <Text style={[text.label, { color: colors.pending }]}>Reconnecting</Text>
                </View>
              )}
            </>
          )}
        </View>

        <Text style={[text.label, { color: colors.faintForeground, marginTop: 22 }]}>
          You asked
        </Text>
        <Text style={[text.display, { color: colors.foreground, marginTop: 6 }]}>{question}</Text>

        {place && (
          <View style={styles.placeLine}>
            <Ionicons name="location" size={14} color={colors.accent} />
            <Text style={[text.subheading, { color: colors.mutedForeground, flex: 1 }]}>
              {place.name}
              <Text style={{ color: colors.faintForeground }}> · {place.area}</Text>
            </Text>
          </View>
        )}

        <GroundMap colors={colors} label={place?.name ?? 'Locating'} live={!settled} />

        {/* ── Closed ───────────────────────────────────────────────
            Shown instead of the progress list, not alongside it. Nobody took
            this one, so every step below would be an empty box and the screen
            would read as a question still waiting for somebody. */}
        {refunded && (
          <View style={[styles.settleWarn, { borderColor: colors.border, marginTop: 26 }]}>
            <Ionicons name="arrow-undo-circle" size={15} color={colors.mutedForeground} />
            <Text style={[text.bodySmall, { color: colors.mutedForeground, flex: 1 }]}>
              You closed this before anybody took it. ₦{formatNaira(query?.bounty ?? 0)} went back
              to your wallet.
            </Text>
          </View>
        )}

        {/* ── Progress ─────────────────────────────────────────────── */}
        {!refunded && (
        <View style={styles.steps}>
          {STEPS.map((step, i) => (
            <View key={i} style={styles.stepRow}>
              <View style={styles.stepGutter}>
                <View
                  style={[
                    styles.stepMark,
                    {
                      borderColor: step.done
                        ? colors.primary
                        : step.live
                          ? colors.accent
                          : colors.border,
                      backgroundColor: step.done ? colors.primary : 'transparent',
                    },
                  ]}
                >
                  {step.done ? (
                    <Ionicons name="checkmark" size={10} color={colors.primaryForeground} />
                  ) : step.live ? (
                    <Pulse color={colors.accent} size={6} />
                  ) : null}
                </View>
                {i < STEPS.length - 1 && (
                  <View
                    style={[
                      styles.stepThread,
                      { backgroundColor: step.done ? colors.primary : colors.border },
                    ]}
                  />
                )}
              </View>

              <View style={styles.stepBody}>
                <Text
                  style={[
                    text.body,
                    {
                      color: step.live || step.done ? colors.foreground : colors.faintForeground,
                      fontFamily: step.live ? font.sansMedium : font.sans,
                    },
                  ]}
                >
                  {step.label}
                </Text>
                {(step.live || step.done) && (
                  <Text style={[text.data, { color: colors.faintForeground, marginTop: 2 }]}>
                    {step.sub}
                  </Text>
                )}
              </View>
            </View>
          ))}
        </View>
        )}

        {/* ── The window ────────────────────────────────────────────
            Once evidence is in, the clock stops mattering: somebody has
            already done the walking, so the money is no longer refundable.

            Gated on `settled` rather than `showFinal`, which only ever meant
            *confirmed*. A question the asker had closed and been refunded for
            was none of confirmed, so the window kept running underneath it and
            went on offering to close and refund something already closed and
            refunded. Settled covers all three ways a question ends. */}
        {!settled && query && (
          <View
            style={[
              styles.clockBox,
              { borderColor: overdue && !shown ? colors.danger : colors.border },
            ]}
          >
            <View style={styles.clockTop}>
              <Ionicons
                name={overdue && !shown ? 'alert-circle' : 'time-outline'}
                size={15}
                color={overdue && !shown ? colors.danger : colors.mutedForeground}
              />
              <Text style={[text.bodySmall, { color: colors.mutedForeground, flex: 1 }]}>
                {/* Says what is known, and nothing more. Before the server
                    has answered, the only true statement is the window. */}
                {shown
                  ? `Delivered inside the ${formatDuration(query.deadlineMinutes)} window.`
                  : !answerLoaded
                    ? `You allowed ${formatDuration(query.deadlineMinutes)}. Checking…`
                    : overdue
                      ? `Nobody delivered inside the ${formatDuration(query.deadlineMinutes)} you allowed.`
                      : `You allowed ${formatDuration(query.deadlineMinutes)}.`}
              </Text>
              <Text
                style={[
                  text.dataMedium,
                  { color: overdue && !shown ? colors.danger : colors.foreground },
                ]}
              >
                {shown ? 'On time' : formatRemaining(msLeft)}
              </Text>
            </View>

            {/* The refund is offered only when it is genuinely owed. */}
            {overdue && !shown && (
              <>
                <Text style={[text.data, { color: colors.faintForeground }]}>
                  Take your ₦{formatNaira(query.bounty)} back, or leave it up and keep waiting.
                </Text>
                <View style={styles.clockActions}>
                  <Pressable
                    /**
                     * Asked before, acknowledged after.
                     *
                     * This closed the question and jumped to the home screen
                     * in the same tap — an irreversible money decision taken
                     * on one press, with nothing to say it had happened. From
                     * the asker's side it read as the button having simply
                     * dismissed the page.
                     */
                    onPress={() => {
                      void (async () => {
                        const sure = await confirm({
                          title: `Close and refund ₦${formatNaira(query.bounty)}?`,
                          message:
                            'The question comes off the board and nobody can answer it. Your money goes back to your wallet.',
                          confirmLabel: 'Close and refund',
                          cancelLabel: 'Keep waiting',
                          tone: 'danger',
                        });
                        if (!sure) return;

                        setClosing(true);
                        // Only claim the money moved once the server says so.
                        const closed = await closeQuery(query.id);
                        if (!closed.ok) {
                          setClosing(false);
                          await notify({
                            title: 'Not closed',
                            message: closed.detail ?? 'That did not go through. Try again.',
                          });
                          return;
                        }

                        /**
                         * And take it out of the contract, which the close
                         * route does not do.
                         *
                         * Closing writes the refund to the ledger only. The
                         * on-chain half has its own endpoint, and nothing in
                         * the app had ever called it — so every question ever
                         * closed left its USDC sitting in escrow while the app
                         * told the asker they had been refunded. Unlike the
                         * release, this needs no signature: the contract
                         * enforces the deadline itself and can only pay the
                         * asker it already recorded.
                         */
                        let stuck: string | null = null;
                        if (query.serverId && (await escrowAvailable())) {
                          const back = await refundJob(query.serverId);
                          if (!back.ok && back.code !== 'not_funded') stuck = back.detail;
                        }

                        setClosing(false);
                        await notify({
                          title: stuck ? 'Closed, but the money has not moved' : 'Refunded',
                          message: stuck
                            ? `The question is closed and nobody can answer it. The on-chain refund did not go through — ${stuck}`
                            : `₦${formatNaira(query.bounty)} is back in your wallet.`,
                        });
                        router.replace('/(tabs)');
                      })();
                    }}
                    disabled={closing}
                    style={({ pressed }) => [
                      styles.refundBtn,
                      {
                        backgroundColor: colors.danger,
                        opacity: pressed || closing ? 0.88 : 1,
                      },
                    ]}
                  >
                    {/*
                      * Shrinks to fit rather than truncating.
                      *
                      * Two buttons have to share this row, and how much room
                      * the words need is not ours to decide: Android measures
                      * this face wider than iOS, and a large accessibility
                      * font scale can double it. Clipping "Refund ₦150" to
                      * "Refun…" hides the amount, which is the one part of a
                      * refund button nobody should have to guess at.
                      *
                      * letterSpacing is dropped here too — it is the most
                      * expensive thing in a narrow button and buys nothing at
                      * this size.
                      */}
                    {closing ? (
                      <View style={styles.refundBusy}>
                        <ActivityIndicator size="small" color={colors.background} />
                        <Text style={[text.action, styles.tightLabel, { color: colors.background }]}>
                          Closing
                        </Text>
                      </View>
                    ) : (
                      <Text
                        numberOfLines={1}
                        adjustsFontSizeToFit
                        minimumFontScale={0.6}
                        style={[text.action, styles.tightLabel, { color: colors.background }]}
                      >
                        Refund ₦{formatNaira(query.bounty)}
                      </Text>
                    )}
                  </Pressable>
                  <Pressable
                    disabled={closing}
                    /**
                     * Waiting on means putting it back, not walking away.
                     *
                     * This navigated home and changed nothing: the question
                     * stayed past its deadline and still locked to a verifier
                     * who never arrived, so nobody else could see it and the
                     * only real option was the refund beside it.
                     */
                    onPress={() => {
                      void (async () => {
                        if (!query.serverId) {
                          router.replace('/(tabs)');
                          return;
                        }
                        const again = await relistQuestion(query.serverId);
                        if (!again.ok) {
                          setSettleError(`Could not put it back — ${again.detail}`);
                          return;
                        }
                        await refreshMyQuestions();
                        await notify({
                          title: 'Back on the board',
                          message: 'Anyone nearby can take it again, and the clock has restarted.',
                        });
                        router.replace('/(tabs)');
                      })();
                    }}
                    style={({ pressed }) => [
                      styles.waitBtn,
                      { borderColor: colors.borderStrong, opacity: pressed ? 0.7 : 1 },
                    ]}
                  >
                    <Text
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.6}
                      style={[text.action, styles.tightLabel, { color: colors.mutedForeground }]}
                    >
                      Keep waiting
                    </Text>
                  </Pressable>
                </View>
              </>
            )}
          </View>
        )}

        {/* ── Dispute ──────────────────────────────────────────────
            Both accounts, in order, so the asker can see exactly where it
            has got to and what the verifier said back. */}
        {dispute && (
          <View
            style={[
              styles.dispute,
              {
                borderColor:
                  dispute.status === 'resolved_verifier'
                    ? colors.primary
                    : dispute.status === 'resolved_asker'
                      ? colors.primary
                      : colors.pending,
              },
            ]}
          >
            <Text
              style={[
                text.label,
                {
                  color: dispute.status.startsWith('resolved')
                    ? colors.primary
                    : colors.pending,
                },
              ]}
            >
              {dispute.status === 'awaiting_verifier' && `Waiting on ${dispute.verifierName}`}
              {dispute.status === 'awaiting_admin' && 'With a reviewer'}
              {dispute.status === 'resolved_asker' && 'Query upheld'}
              {dispute.status === 'resolved_verifier' && 'Evidence stood'}
            </Text>

            <Text style={[text.bodySmall, { color: colors.mutedForeground, marginTop: 6 }]}>
              {dispute.status === 'awaiting_verifier' &&
                'They have been asked to answer your query. Your money stays held until this is settled.'}
              {dispute.status === 'awaiting_admin' &&
                'Both sides are in. A person is reading them along with the evidence.'}
              {dispute.status === 'resolved_asker' &&
                `The reviewer agreed with you. ₦${formatNaira(dispute.bounty)} has gone back to your wallet.`}
              {dispute.status === 'resolved_verifier' &&
                `The reviewer found the evidence held up, so ${dispute.verifierName} was paid.`}
            </Text>

            <View style={[styles.side, { borderColor: colors.border }]}>
              <Text style={[text.data, { color: colors.faintForeground }]}>You said</Text>
              <Text style={[text.bodySmall, { color: colors.foreground, marginTop: 3 }]}>
                {dispute.askerReason}
              </Text>
            </View>

            {dispute.verifierReply && (
              <View style={[styles.side, { borderColor: colors.border }]}>
                <Text style={[text.data, { color: colors.faintForeground }]}>
                  {dispute.verifierName} said
                </Text>
                <Text style={[text.bodySmall, { color: colors.foreground, marginTop: 3 }]}>
                  {dispute.verifierReply}
                </Text>
              </View>
            )}

            {dispute.adminNote && (
              <View style={[styles.side, { borderColor: colors.primary }]}>
                <Text style={[text.data, { color: colors.primary }]}>Reviewer</Text>
                <Text style={[text.bodySmall, { color: colors.foreground, marginTop: 3 }]}>
                  {dispute.adminNote}
                </Text>
              </View>
            )}
          </View>
        )}

        {dispatchError && (
          <View style={[styles.settleWarn, { borderColor: colors.danger, marginTop: 18 }]}>
            <Ionicons name="close-circle-outline" size={16} color={colors.danger} />
            <View style={{ flex: 1, gap: 8 }}>
              <Text style={[text.bodySmall, { color: colors.danger }]}>{dispatchError}</Text>
              <Pressable
                onPress={() => {
                  clearDispatchError();
                  router.back();
                }}
              >
                <Text style={[text.action, { color: colors.accent }]}>Go back and try again</Text>
              </Pressable>
            </View>
          </View>
        )}

        {shown && (
          <>
            <Text style={[text.label, { color: colors.faintForeground, marginTop: 32, marginBottom: 4 }]}>
              What came back
            </Text>
            <Text style={[text.bodySmall, { color: colors.mutedForeground, marginBottom: 14 }]}>
              Confirm it if it answers your question. Query it if it looks wrong.
            </Text>
            {/* The decision stuck but the money did not move. Said plainly,
                because silence here reads as "paid". */}
            {settleError && (
              <View style={[styles.settleWarn, { borderColor: colors.pending }]}>
                <Ionicons name="warning-outline" size={15} color={colors.pending} />
                <Text style={[text.bodySmall, { color: colors.pending, flex: 1 }]}>
                  {settleError}
                </Text>
              </View>
            )}

            {sentPastCheck && (
              <View style={[styles.settleWarn, { borderColor: colors.danger }]}>
                <Ionicons name="alert-circle-outline" size={15} color={colors.danger} />
                <Text style={[text.bodySmall, { color: colors.danger, flex: 1 }]}>
                  {sentPastCheck === 'fail'
                    ? 'The automatic check rejected this and the verifier sent it anyway. Look at it closely before you confirm — query it if it is wrong, and the reviewer will see that they were warned.'
                    : 'The automatic check flagged something here and the verifier sent it anyway. Have a proper look before you confirm.'}
                </Text>
              </View>
            )}

            <VerificationCard
              verification={response}
              /**
               * Nothing left to decide once a query is open.
               *
               * `action` is this screen's memory of the tap and resets on every
               * reload, so after a refresh the buttons came back and offered to
               * query a question that was already with a reviewer — or to
               * confirm evidence the asker had just objected to. The dispute
               * row is the durable answer to "has this been ruled on yet".
               */
              showActions={action === null && dispute === null}
              payout={verifierCut(query?.bounty ?? 0)}
              onConfirm={handleConfirm}
              onQuery={handleQuery}
            />
          </>
        )}

        {/* ── Leaving does not cancel anything ─────────────────────
            Watching a progress list is not work, and someone is walking
            somewhere either way. Say so plainly and offer the exit.

            Shown whenever the question is still open, including once it is
            overdue. It used to disappear at the deadline, which conflated two
            different actions: the overdue banner offers "Close · Refund",
            which ends the *question*, while this ends the *screen*. Somebody
            who wants to keep waiting was left with no way out but the browser
            back button. */}
        {!showFinal && (
          <View style={[styles.leaveBox, { borderColor: colors.border }]}>
            <View style={styles.leaveTop}>
              <Ionicons name="notifications-outline" size={15} color={colors.mutedForeground} />
              <Text style={[text.bodySmall, { color: colors.mutedForeground, flex: 1 }]}>
                {shown
                  ? 'Nothing expires while you are away. Pick this back up from Your questions on the Ask tab.'
                  : overdue
                    ? 'Your money is still held. Leave this open or close it above — either way nothing is lost.'
                    : `This carries on without you. We will alert you the moment ${worker.toLowerCase()} sends the evidence.`}
              </Text>
            </View>

            <Pressable
              onPress={() => router.replace('/(tabs)')}
              style={({ pressed }) => [
                styles.leaveBtn,
                { borderColor: colors.borderStrong, opacity: pressed ? 0.7 : 1 },
              ]}
            >
              <Ionicons name="home-outline" size={15} color={colors.foreground} />
              <Text style={[text.action, { color: colors.foreground }]}>Close and wait</Text>
            </Pressable>
          </View>
        )}

        {/* ── Settled ──────────────────────────────────────────────── */}
        {showFinal && (
          <Animated.View style={{ opacity: fade }}>
            <View
              style={[
                styles.answer,
                { backgroundColor: colors.primarySoft, borderColor: colors.primary },
              ]}
            >
              <Text style={[text.label, { color: colors.primary }]}>Verified answer</Text>
              <Text style={[styles.answerText, { color: colors.foreground }]}>
                {response.response}
              </Text>
              <Text style={[text.bodySmall, { color: colors.mutedForeground }]}>
                {response.detail}
              </Text>
              <Text style={[text.bodySmall, { color: colors.mutedForeground }]}>
                You confirmed this as accurate, so {worker} has been paid ₦
                {formatNaira(verifierCut(query?.bounty ?? 0))} of your ₦
                {formatNaira(query?.bounty ?? 0)} after the platform fee.
              </Text>
            </View>

            <Pressable
              onPress={() => router.replace('/(tabs)')}
              style={({ pressed }) => [
                styles.homeBtn,
                { backgroundColor: colors.foreground, opacity: pressed ? 0.88 : 1 },
              ]}
            >
              <Text style={[text.action, { color: colors.background }]}>Back to Ask</Text>
            </Pressable>
          </Animated.View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { paddingHorizontal: 20, paddingBottom: 44 },

  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  backBtn: {
    width: 38,
    height: 38,
    borderRadius: 2,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  liveTag: { flexDirection: 'row', alignItems: 'center', gap: 6 },

  placeLine: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 12 },
  steps: { marginTop: 26 },
  stepRow: { flexDirection: 'row', gap: 12 },
  stepGutter: { alignItems: 'center', width: 18 },
  stepMark: {
    width: 18,
    height: 18,
    borderRadius: 2,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepThread: { width: 1.5, flex: 1, minHeight: 12, marginVertical: 3 },
  stepBody: { flex: 1, paddingBottom: 18 },

  clockBox: { borderWidth: 2, borderRadius: 2, padding: 14, gap: 10, marginTop: 4 },
  clockTop: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  clockActions: { flexDirection: 'row', gap: 9 },
  // Tracking costs real width at button size, and these two have none to give.
  tightLabel: { letterSpacing: 0.2 },
  refundBusy: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  /**
   * Both halves share the row rather than one taking what the other leaves.
   *
   * refundBtn was flex: 1 and waitBtn was sized to its own text, so the row's
   * width depended on how wide the platform drew "Keep waiting" — fine on iOS
   * and not on Android, where this face measures wider and the pair no longer
   * fitted side by side.
   *
   * minWidth: 0 is the part that actually holds it: without it a flex child
   * will not shrink below its content, which is how a row with flex children
   * still manages to overflow.
   */
  refundBtn: {
    /**
     * Roughly two thirds of the row.
     *
     * It carries a verb and an amount where its neighbour carries two words,
     * so an even split starved the longer label and left it shrinking to fit
     * while the shorter one sat in space it did not need. The width is also
     * the point: this is the decision the banner is offering, and "keep
     * waiting" is the way out of it, not its equal.
     *
     * 3 and 2 rather than percentages: 3/(3+2) is exactly the 60% wanted, and
     * flexbox takes the 9px gap out of the space before dividing it. Setting
     * flexBasis to '60%' and '40%' would come to 100% of the row *plus* the
     * gap, and overflow by exactly that much.
     */
    flex: 3,
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 2,
    paddingVertical: 13,
    paddingHorizontal: 10,
  },
  waitBtn: {
    // The other 40%. See refundBtn for why these are 3 and 2.
    flex: 2,
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderRadius: 2,
    paddingVertical: 13,
    paddingHorizontal: 10,
  },

  leaveBox: { borderWidth: 2, borderRadius: 2, padding: 14, gap: 12, marginTop: 12 },
  leaveTop: { flexDirection: 'row', gap: 9 },
  leaveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 2,
    borderRadius: 2,
    paddingVertical: 12,
  },

  dispute: { borderWidth: 2, borderRadius: 2, padding: 16, marginTop: 10 },
  settleWarn: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
    borderWidth: 2,
    borderRadius: 2,
    padding: 12,
    marginBottom: 12,
  },
  side: { borderWidth: 2, borderRadius: 2, padding: 11, marginTop: 10 },

  answer: { borderWidth: 2, borderRadius: 2, padding: 20, gap: 8, marginTop: 8 },
  answerText: { fontFamily: font.sansBold, fontSize: 21, lineHeight: 27, letterSpacing: -0.1 },
  homeBtn: {
    borderRadius: 2,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 16,
  },
});
